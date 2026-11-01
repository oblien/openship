import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consoleErrorSink,
  ErrorReporter,
  errorReporter,
  reportCaughtError,
  type ErrorEvent,
} from "@repo/core/diagnostics";
import { createDatabase, sql, type DatabaseConnection } from "@repo/db/factory";
import {
  createCloudErrorSink,
  installCloudErrorDestination,
} from "../../src/lib/cloud-error-destination";

const config = vi.hoisted(() => ({ CLOUD_MODE: false }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: config }));
vi.mock("@repo/db", () => ({
  get db() {
    return connection.db;
  },
  getDriver: () => connection.driver,
}));

let connection: DatabaseConnection;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
}, 30_000);
beforeEach(async () => {
  config.CLOUD_MODE = false;
  errorReporter.setEnabled(false);
  await connection.db.execute(sql`DROP TABLE IF EXISTS cloud_error_event`);
});
afterEach(async () => {
  await errorReporter.flush();
  errorReporter.setEnabled(false);
  errorReporter.setSink(consoleErrorSink);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await connection?.close();
});

async function stored(): Promise<ErrorEvent[]> {
  const result = await connection.db.execute(
    sql`SELECT event FROM cloud_error_event ORDER BY received_at, event_id`,
  );
  return result.rows.map((row) => (row as { event: ErrorEvent }).event);
}

async function snapshot(message: string): Promise<ErrorEvent> {
  const events: ErrorEvent[] = [];
  const reporter = new ErrorReporter({
    sink: (batch) => {
      events.push(...batch);
    },
  });
  reporter.capture(new Error(message), {
    source: "api",
    requestId: "request-1",
    organizationId: "org-1",
  });
  await reporter.flush();
  return events[0]!;
}

describe("Cloud-only diagnostic storage", () => {
  it("does not create a table or capture a recovered error outside Cloud", async () => {
    const sink = vi.fn();
    errorReporter.setSink(sink);
    await installCloudErrorDestination();
    reportCaughtError(new Error("private local failure"), "self-hosted");
    await errorReporter.flush();
    expect(errorReporter.isEnabled()).toBe(false);
    expect(sink).not.toHaveBeenCalled();
    const table = await connection.db.execute(sql`SELECT to_regclass('cloud_error_event') AS name`);
    expect(table.rows[0]).toEqual({ name: null });
  });

  it("installs the shared destination only in Cloud and persists caught errors", async () => {
    config.CLOUD_MODE = true;
    await installCloudErrorDestination();
    reportCaughtError(new Error("password=secret-cloud-913"), "api/test");
    await errorReporter.flush();
    expect(errorReporter.isEnabled()).toBe(true);
    const events = await stored();
    expect(events).toHaveLength(1);
    expect(events[0]!.context.component).toBe("api/test");
    expect(JSON.stringify(events)).not.toContain("secret-cloud-913");
  });

  it("creates the table idempotently and deduplicates a replayed batch by event ID", async () => {
    const sink = await createCloudErrorSink(connection.db, connection.driver);
    const event = await snapshot("provider failed");
    const signal = new AbortController().signal;
    await sink([event, event], signal);
    const restarted = await createCloudErrorSink(connection.db, connection.driver);
    await restarted([event], signal);
    expect(await stored()).toEqual([event]);
  });

  it("stores sanitized context and error causes without attached payloads", async () => {
    const sink = await createCloudErrorSink(connection.db, connection.driver);
    const reporter = new ErrorReporter({ sink });
    reporter.capture(
      Object.assign(
        new Error("Dependency unavailable", {
          cause: new Error("Authorization: Bearer secret-token-913"),
        }),
        { request: { headers: { cookie: "secret-cookie-913" } }, query: "secret-query-913" },
      ),
      {
        source: "api",
        kind: "http",
        requestId: "request-2",
        organizationId: "org-2",
        statusCode: 502,
      },
    );
    expect(await reporter.flush()).toBe(true);
    const events = await stored();
    expect(events[0]).toMatchObject({
      category: "dependency",
      severity: "error",
      context: { requestId: "request-2", organizationId: "org-2", statusCode: 502 },
      error: { cause: { message: "[REDACTED HEADER]" } },
    });
    expect(JSON.stringify(events)).not.toMatch(/secret-(token|cookie|query)-913/);
  });

  it("stores literal SQL-looking text and repairs invalid Unicode without losing the batch", async () => {
    const sink = await createCloudErrorSink(connection.db, connection.driver);
    const event = await snapshot("plain failure");
    event.error.message = "literal '); DROP TABLE cloud_error_event; -- \ud83d \udc00 \u0000 😀";
    await sink([event], new AbortController().signal);
    const events = await stored();
    expect(events).toHaveLength(1);
    expect(events[0]!.error.message).toBe("literal '); DROP TABLE cloud_error_event; -- � �  😀");
  });

  it("does not insert cancelled batches, including a batch waiting for the database", async () => {
    const sink = await createCloudErrorSink(connection.db, connection.driver);
    const event = await snapshot("abandoned");
    const controller = new AbortController();
    controller.abort();
    await sink([event], controller.signal);

    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holding = connection.db.transaction(async () => {
      ready();
      await held;
    });
    await started;
    const queued = new AbortController();
    const delivery = Promise.resolve(sink([event], queued.signal));
    // Attach a rejection assertion before releasing the held transaction.
    const rejected = expect(delivery).rejects.toMatchObject({ name: "AbortError" });
    queued.abort();
    release();
    await holding;
    await rejected;
    expect(await stored()).toHaveLength(0);
  });

  it("expires only old diagnostic rows in bounded batches", async () => {
    const sink = await createCloudErrorSink(connection.db, connection.driver);
    const event = await snapshot("recent event");
    await connection.db.execute(sql`
      INSERT INTO cloud_error_event (event_id, occurred_at, received_at, event)
      SELECT 'expired-' || n, now(), now() - interval '31 days', '{}'::jsonb
      FROM generate_series(1, 1001) AS n
    `);
    await sink([event], new AbortController().signal);
    expect(await stored()).toHaveLength(2);
    await sink([event], new AbortController().signal);
    expect(await stored()).toEqual([event]);
    const timeout = await connection.db.execute(sql`SHOW statement_timeout`);
    expect(timeout.rows[0]).toEqual({ statement_timeout: "0" });
  });

  it("falls back locally without recursive database calls if inserts fail", async () => {
    const sink = await createCloudErrorSink(connection.db, connection.driver);
    const fallback: ErrorEvent[] = [];
    const reporter = new ErrorReporter({
      sink,
      fallback: (events) => {
        fallback.push(...events);
      },
    });
    await connection.db.execute(sql`DROP TABLE cloud_error_event`);
    reporter.capture(new Error("original operation failed"));
    expect(await reporter.flush()).toBe(true);
    expect(fallback).toHaveLength(2);
    expect(fallback[0]!.error.message).toBe("original operation failed");
    expect(fallback[1]!.error.code).toBe("DIAGNOSTICS_DELIVERY_FAILED");
    expect(reporter.stats().deliveryFailures).toBe(1);
  });

  it("keeps startup working when the Cloud table cannot be created", async () => {
    const local = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((_chunk: unknown, callback?: unknown) => {
        if (typeof callback === "function") callback();
        return true;
      });
    config.CLOUD_MODE = true;
    vi.spyOn(connection.db, "transaction").mockRejectedValue(new Error("database unavailable"));
    await expect(installCloudErrorDestination()).resolves.toBeUndefined();
    reportCaughtError(new Error("still serving requests"), "api/test");
    await errorReporter.flush();
    expect(local).toHaveBeenCalled();
    expect(local.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      "still serving requests",
    );
  });
});
