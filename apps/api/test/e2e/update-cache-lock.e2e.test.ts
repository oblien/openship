import { createEncryption } from "@repo/db/encryption";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { withTimeout } from "@repo/core";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const container = `openship-e2e-update-lock-${process.pid}`;
let connection: DatabaseConnection | undefined;
let repos: ReturnType<typeof createRepositories>;
const row = (latestSha: string) => ({
  organizationId: "org",
  projectId: "project",
  kind: "commit",
  checkedAt: new Date(),
  detail: { key: "example/app#main", latestSha },
});

describeDockerE2E("update cache lock deadlines (GH-880, real PostgreSQL)", () => {
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
        "POSTGRES_PASSWORD=cache-test-password",
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
      url: `postgresql://postgres:cache-test-password@127.0.0.1:${port}/postgres`,
      migrationsDir: resolve(import.meta.dirname, "../../../../packages/db/drizzle"),
      poolMax: 3,
      registerExitHook: false,
    });
    repos = createRepositories(connection.db, createEncryption("repository-test-secret"));
    await connection.db.insert(schema.organization).values({ id: "org", name: "Cache test" });
    await connection.db
      .insert(schema.projectGroup)
      .values({ id: "group", organizationId: "org", name: "Test", slug: "test" });
    await connection.db.insert(schema.project).values({
      id: "project",
      groupId: "group",
      organizationId: "org",
      name: "Test",
      slug: "test",
    });
  }, 150_000);
  beforeEach(async () => {
    await repos.updateStatus.deleteByProject("project");
    await repos.updateStatus.upsert(row("old"));
  });
  afterAll(async () => {
    try {
      await connection?.close();
    } finally {
      await exec("docker", ["rm", "-fv", container]).catch(() => {});
    }
  });

  it.each(["upsert", "delete"] as const)(
    "releases a blocked %s and can write again after the lock is released",
    async (operation) => {
      const pool = connection!.pool!;
      const locker = await pool.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM update_status WHERE project_id = 'project' FOR UPDATE");
      const started = performance.now();
      try {
        const pending =
          operation === "upsert"
            ? repos.updateStatus.upsert(row("new"))
            : repos.updateStatus.deleteByProject("project");
        // Check the server error, not just any rejection: this must be a real
        // lock timeout, with the transaction rolled back and connection reusable.
        await expect(
          withTimeout(pending, 5_000, "Cache write did not release its lock wait"),
        ).rejects.toMatchObject({ cause: { code: "55P03" } });
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(await repos.updateStatus.getByProject("project")).toMatchObject({
          detail: { latestSha: "old" },
        });
        expect((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
        expect((await pool.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
      await repos.updateStatus.upsert(row("recovered"));
      expect(await repos.updateStatus.getByProject("project")).toMatchObject({
        detail: { latestSha: "recovered" },
      });
    },
  );
});
