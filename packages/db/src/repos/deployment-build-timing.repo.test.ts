import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const START = new Date("2026-09-24T10:00:00Z");
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDeploymentRepo(db, createEncryption("repository-test-secret"));

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
});
afterAll(async () => {
  await client.close();
});
afterEach(() => vi.useRealTimers());

async function seed(id: string, startedAt: Date | null = START) {
  await db.insert(schema.deployment).values({
    id,
    projectId: id,
    organizationId: "org1",
    branch: "main",
    status: "building",
  });
  await db.insert(schema.buildSession).values({
    id: `session-${id}`,
    deploymentId: id,
    projectId: id,
    status: "building",
    startedAt,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START.getTime() + 15_000);
}

describe("cancelled build timing (#919)", () => {
  it.each(["cancelInFlight", "updateStatus"] as const)(
    "%s records cancellation and its duration together without releasing the worker",
    async (method) => {
      await seed(method);
      const cancelled =
        method === "updateStatus"
          ? await repo.updateStatus(method, "cancelled")
          : await repo.cancelInFlight(method);
      expect(cancelled).toBe(true);
      expect(await repo.findBuildSessionByDeploymentId(method)).toMatchObject({
        status: "cancelled",
        durationMs: 15_000,
        finishedAt: null,
      });
      expect(await repo.hasLiveBuildExecution(method, method)).toBe(true);
    },
  );

  it("keeps one final duration across late handler/worker writes and preserves their logs", async () => {
    const id = "racing-writers";
    await seed(id);
    await repo.cancelInFlight(id);
    vi.setSystemTime(START.getTime() + 60_000);
    const logs = [{ timestamp: START.toISOString(), level: "info", message: "Cleanup finished" }];
    await Promise.all([
      repo.finishBuildSession(`session-${id}`, "cancelled", 60_000),
      repo.finishBuildSession(`session-${id}`, "cancelled", 0, logs),
      repo.finishBuildSession(`session-${id}`, "ready", 7000),
    ]);
    expect(await repo.findBuildSessionByDeploymentId(id)).toMatchObject({
      status: "cancelled",
      durationMs: 15_000,
      finishedAt: null,
      logs,
    });
    await repo.acknowledgeBuildExecutionFinished(`session-${id}`);
    expect(await repo.findBuildSessionByDeploymentId(id)).toMatchObject({ durationMs: 15_000 });
    expect(await repo.hasLiveBuildExecution(id, id)).toBe(false);
  });

  it("does not change a successful build's duration when a late cancel loses", async () => {
    const id = "ready-first";
    await seed(id);
    await repo.updateStatus(id, "ready");
    await repo.finishBuildSession(`session-${id}`, "ready", 2500);
    expect(await repo.cancelInFlight(id)).toBe(false);
    expect(await repo.findBuildSessionByDeploymentId(id)).toMatchObject({
      status: "ready",
      durationMs: 2500,
    });
  });

  it("records zero for an unstarted cancellation without inventing a start timestamp", async () => {
    const id = "unstarted";
    await seed(id, null);
    await repo.cancelInFlight(id);
    expect(await repo.findBuildSessionByDeploymentId(id)).toMatchObject({
      status: "cancelled",
      durationMs: 0,
      startedAt: null,
      finishedAt: null,
    });
  });

  it.each([false, true])(
    "salvages invalid logs without changing the result (cancelled: %s)",
    async (cancelled) => {
      const id = `invalid-logs-${cancelled}`;
      await seed(id);
      if (cancelled) await repo.cancelInFlight(id);
      else await repo.updateStatus(id, "ready");
      await repo.finishBuildSession(`session-${id}`, "ready", 4321, [
        { timestamp: START.toISOString(), level: "info", message: "invalid\u0000log" },
      ]);
      const row = await repo.findBuildSessionByDeploymentId(id);
      expect(row).toMatchObject({
        status: cancelled ? "cancelled" : "ready",
        durationMs: cancelled ? 15_000 : 4321,
        finishedAt: null,
      });
      expect(JSON.stringify(row?.logs)).toContain("Build logs could not be stored");
    },
  );

  it("rolls back the outcome if its timing write fails, allowing a consistent retry", async () => {
    const id = "transaction-failure";
    await seed(id);
    await client.exec(`
      CREATE FUNCTION reject_timing_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'temporary timing failure'; END $$;
      CREATE TRIGGER reject_timing_write BEFORE UPDATE ON build_session
      FOR EACH ROW EXECUTE FUNCTION reject_timing_write();
      ALTER TABLE build_session ENABLE ALWAYS TRIGGER reject_timing_write;
    `);
    try {
      await expect(repo.cancelInFlight(id)).rejects.toThrow();
      expect(await repo.findById(id)).toMatchObject({ status: "building" });
      expect(await repo.findBuildSessionByDeploymentId(id)).toMatchObject({
        status: "building",
        durationMs: null,
      });
    } finally {
      await client.exec(
        "DROP TRIGGER reject_timing_write ON build_session; DROP FUNCTION reject_timing_write();",
      );
    }
    expect(await repo.cancelInFlight(id)).toBe(true);
  });
});
