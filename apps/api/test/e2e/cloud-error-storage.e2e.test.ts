import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { ErrorReporter, type ErrorEvent } from "@repo/core/diagnostics";
import { createDatabase, sql, type DatabaseConnection } from "@repo/db/factory";
import { createCloudErrorSink } from "../../src/lib/cloud-error-destination";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const container = `openship-e2e-cloud-errors-${process.pid}`;
let connection: DatabaseConnection;
let event: ErrorEvent;

describeDockerE2E("Cloud error storage on real PostgreSQL", () => {
  beforeAll(async () => {
    await requireDocker();
    await exec(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-e",
        "POSTGRES_PASSWORD=diagnostics-test-password",
        "-p",
        "127.0.0.1::5432",
        "postgres:16-alpine",
      ],
      { timeout: 120_000 },
    );
    const port = (await exec("docker", ["port", container, "5432/tcp"])).stdout
      .trim()
      .split(":")
      .at(-1);
    connection = await createDatabase({
      driver: "pg",
      url: `postgresql://postgres:diagnostics-test-password@127.0.0.1:${port}/postgres`,
      migrationsDir: resolve(import.meta.dirname, "../../../../packages/db/drizzle"),
      poolMax: 4,
    });
    const reporter = new ErrorReporter({
      sink: (events) => {
        event = events[0]!;
      },
    });
    reporter.capture(new Error("postgresql destination probe"), {
      requestId: "postgres-request",
      source: "api",
    });
    await reporter.flush();
  });
  beforeEach(async () => {
    await connection.db.execute(sql`DROP TABLE IF EXISTS cloud_error_event`);
  });
  afterAll(async () => {
    try {
      await connection?.close();
    } finally {
      await exec("docker", ["rm", "-fv", container]).catch(() => {});
    }
  });

  it("serializes replica startup and deduplicates concurrent delivery", async () => {
    const sinks = await Promise.all(
      Array.from({ length: 4 }, () => createCloudErrorSink(connection.db, "pg")),
    );
    await Promise.all(sinks.map((sink) => sink([event], new AbortController().signal)));
    const rows = await connection.db.execute(sql`SELECT event FROM cloud_error_event`);
    expect(rows.rows).toEqual([{ event }]);
  });

  it("waits for another replica's schema setup beyond the delivery lock deadline", async () => {
    const locker = await connection.pool!.connect();
    let startup: ReturnType<typeof createCloudErrorSink> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock($1)", [0x6f736865]);
      startup = createCloudErrorSink(connection.db, "pg");
      const ready = startup.then(
        () => null,
        (error: unknown) => error,
      );
      // A competing replica can legitimately hold the DDL lock longer than
      // the 250 ms allowed to a best-effort diagnostic INSERT.
      await new Promise((resolve) => setTimeout(resolve, 750));
      await locker.query("COMMIT");
      expect(await ready).toBeNull();
      const sink = await startup;
      await sink([event], new AbortController().signal);
      expect(
        (await connection.db.execute(sql`SELECT event_id FROM cloud_error_event`)).rows,
      ).toHaveLength(1);
      expect(
        (
          await connection.pool!.query(
            "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement",
          )
        ).rows,
      ).toEqual([{ lock: "0", statement: "0" }]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await startup?.catch(() => {});
    }
  });

  it("falls back on a database lock deadline and leaves pooled settings unchanged", async () => {
    const sink = await createCloudErrorSink(connection.db, "pg");
    const fallback: ErrorEvent[] = [];
    const reporter = new ErrorReporter({
      sink,
      fallback: (events) => {
        fallback.push(...events);
      },
    });
    const locker = await connection.pool!.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE cloud_error_event IN ACCESS EXCLUSIVE MODE");
      reporter.capture(new Error("blocked insert"));
      expect(await reporter.flush()).toBe(true);
      expect(fallback).toHaveLength(2);
      expect(fallback[1]!.error.code).toBe("DIAGNOSTICS_DELIVERY_FAILED");
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    const settings = await connection.pool!.query(
      "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement",
    );
    expect(settings.rows).toEqual([{ lock: "0", statement: "0" }]);
    expect((await connection.db.execute(sql`SELECT event_id FROM cloud_error_event`)).rows).toEqual(
      [],
    );
    await sink([event], new AbortController().signal);
    expect(
      (await connection.db.execute(sql`SELECT event_id FROM cloud_error_event`)).rows,
    ).toHaveLength(1);
  });

  it("does not insert a cancelled batch when an exhausted pool becomes available", async () => {
    const sink = await createCloudErrorSink(connection.db, "pg");
    const clients = await Promise.all(Array.from({ length: 4 }, () => connection.pool!.connect()));
    const controller = new AbortController();
    try {
      const pending = Promise.resolve(sink([event], controller.signal));
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      clients.shift()!.release();
      await rejected;
    } finally {
      for (const client of clients) client.release();
    }
    expect((await connection.db.execute(sql`SELECT event_id FROM cloud_error_event`)).rows).toEqual(
      [],
    );
  });
});
