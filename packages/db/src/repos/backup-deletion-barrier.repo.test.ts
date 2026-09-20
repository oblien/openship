import { beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createBackupRestoreRepo, createBackupRunRepo } from "./backup.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function freshRepos(deletionInProgress: boolean) {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.project).values({
    id: "p1",
    organizationId: "org1",
    groupId: "g1",
    name: "app",
    slug: "app",
    deletionInProgress,
  });
  return {
    db,
    run: createBackupRunRepo(db),
    restore: createBackupRestoreRepo(db),
  };
}

describe("backup/restore creation vs. project deletion", () => {
  let repos: Awaited<ReturnType<typeof freshRepos>>;

  beforeEach(async () => {
    repos = await freshRepos(true);
  }, 30_000);

  it("refuses a new project backup after deletion is claimed", async () => {
    await expect(
      repos.run.create({
        id: "run-project",
        projectId: "p1",
        organizationId: "org1",
        status: "queued",
        triggeredBy: "manual",
      }),
    ).rejects.toThrow(/project is being deleted/i);
  });

  it("refuses a new project restore after deletion is claimed", async () => {
    await expect(
      repos.restore.create({
        id: "restore-project",
        runId: "source-run",
        destinationId: "destination",
        projectId: "p1",
        organizationId: "org1",
        status: "queued",
      }),
    ).rejects.toThrow(/project is being deleted/i);
  });

  it("does not apply a project barrier to mail-server-only work", async () => {
    const run = await repos.run.create({
      id: "run-mail",
      projectId: null,
      organizationId: "org1",
      sourceKind: "mail_server",
      status: "queued",
      triggeredBy: "manual",
    });

    expect(run.id).toBe("run-mail");

    const restore = await repos.restore.create({
      id: "restore-mail",
      runId: run.id,
      destinationId: "destination",
      projectId: null,
      organizationId: "org1",
      status: "prepared",
    });
    await expect(repos.restore.claimApply(restore.id, null, restore.organizationId)).resolves.toBe(
      "claimed",
    );
  });

  it("atomically gives one queued backup delivery the execution lease", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-duplicate-delivery",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });

    const claims = await Promise.all([
      live.run.claimExecution(row.id, row.projectId, row.organizationId),
      live.run.claimExecution(row.id, row.projectId, row.organizationId),
    ]);

    expect(claims.sort()).toEqual(["claimed", "state_changed"]);
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "preparing",
      executionStartedAt: expect.any(Date),
      executionFinishedAt: null,
    });
  });

  it("refuses a queued backup worker after deletion claims the project", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-delete-won",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });
    await live.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(live.run.claimExecution(row.id, row.projectId, row.organizationId)).resolves.toBe(
      "project_unavailable",
    );
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "queued",
      executionStartedAt: null,
    });
  });

  it("cancels an unclaimed queued backup after deletion closes worker admission", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-delete-cancelled",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });
    await live.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(
      live.run.cancelQueuedBeforeExecution(row.id, row.projectId!, row.organizationId),
    ).resolves.toBe(true);
    await expect(live.run.claimExecution(row.id, row.projectId, row.organizationId)).resolves.toBe(
      "project_unavailable",
    );
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "cancelled",
      executionStartedAt: null,
      executionFinishedAt: null,
      finishedAt: expect.any(Date),
    });
    expect(await live.run.listInFlightByProject("p1")).toEqual([]);
  });

  it("never relabels a backup after a worker has claimed it", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-claimed-not-cancelled",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });
    await live.run.claimExecution(row.id, row.projectId, row.organizationId);

    await expect(
      live.run.cancelQueuedBeforeExecution(row.id, row.projectId!, row.organizationId),
    ).resolves.toBe(false);
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "preparing",
      executionStartedAt: expect.any(Date),
      executionFinishedAt: null,
    });
  });

  it("keeps a terminal backup in-flight until its live worker acknowledges", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-terminal-live-worker",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });
    await live.run.claimExecution(row.id, row.projectId, row.organizationId);
    await live.run.transition(row.id, "succeeded");

    expect((await live.run.listInFlightByProject("p1")).map((run) => run.id)).toEqual([row.id]);
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "succeeded",
      finishedAt: expect.any(Date),
      executionFinishedAt: null,
    });

    await live.run.acknowledgeExecutionFinished(row.id);
    expect(await live.run.listInFlightByProject("p1")).toEqual([]);
  });

  it("heartbeat reconciliation records an outcome without faking worker completion", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-stale-live-worker",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });
    await live.run.claimExecution(row.id, row.projectId, row.organizationId);

    const future = new Date(Date.now() + 60_000);
    await expect(
      live.run.sweepRunsWithStaleHeartbeat({
        idleCutoff: future,
        ceilingCutoff: future,
        reason: "stale",
      }),
    ).resolves.toBe(1);
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "server_error",
      executionFinishedAt: null,
    });
    expect((await live.run.listInFlightByProject("p1")).map((run) => run.id)).toEqual([row.id]);
  });

  it("boot recovery alone closes an orphaned execution lease without replacing its verdict", async () => {
    const live = await freshRepos(false);
    const row = await live.run.create({
      id: "run-crashed-after-outcome",
      projectId: "p1",
      organizationId: "org1",
      status: "queued",
      triggeredBy: "manual",
    });
    await live.run.claimExecution(row.id, row.projectId, row.organizationId);
    await live.run.transition(row.id, "failed", { errorMessage: "capture failed" });

    await expect(live.run.sweepStaleRuns("process restarted")).resolves.toBe(1);
    expect(await live.run.findById(row.id)).toMatchObject({
      status: "failed",
      errorMessage: "capture failed",
      executionFinishedAt: expect.any(Date),
    });
    expect(await live.run.listInFlightByProject("p1")).toEqual([]);
  });

  it("atomically claims a prepared restore before destructive apply work starts", async () => {
    const live = await freshRepos(false);
    const row = await live.restore.create({
      id: "restore-prepared",
      runId: "source-run",
      destinationId: "destination",
      projectId: "p1",
      organizationId: "org1",
      status: "prepared",
    });

    await expect(live.restore.claimApply(row.id, row.projectId, row.organizationId)).resolves.toBe(
      "claimed",
    );
    expect((await live.restore.findById(row.id))?.status).toBe("applying");
  });

  it("never claims a restore through a different project or organization", async () => {
    const live = await freshRepos(false);
    await live.db.insert(schema.project).values([
      {
        id: "p2",
        organizationId: "org1",
        groupId: "g2",
        name: "other",
        slug: "other",
      },
      {
        id: "p3",
        organizationId: "org2",
        groupId: "g3",
        name: "foreign",
        slug: "foreign",
      },
    ]);
    const row = await live.restore.create({
      id: "restore-scope",
      runId: "source-run",
      destinationId: "destination",
      projectId: "p1",
      organizationId: "org1",
      status: "prepared",
    });

    await expect(live.restore.claimApply(row.id, "p2", "org1")).resolves.toBe("state_changed");
    await expect(live.restore.claimApply(row.id, "p3", "org2")).resolves.toBe("state_changed");
    expect((await live.restore.findById(row.id))?.status).toBe("prepared");
  });

  it("refuses prepared-to-applying after project deletion has claimed the row", async () => {
    const live = await freshRepos(false);
    const row = await live.restore.create({
      id: "restore-delete-won",
      runId: "source-run",
      destinationId: "destination",
      projectId: "p1",
      organizationId: "org1",
      status: "prepared",
    });
    await live.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(live.restore.claimApply(row.id, row.projectId, row.organizationId)).resolves.toBe(
      "project_unavailable",
    );
    expect((await live.restore.findById(row.id))?.status).toBe("prepared");
  });

  it("does not cross a durable cancel request with a late apply claim", async () => {
    const live = await freshRepos(false);
    const row = await live.restore.create({
      id: "restore-cancel-won",
      runId: "source-run",
      destinationId: "destination",
      projectId: "p1",
      organizationId: "org1",
      status: "prepared",
    });
    await live.restore.requestCancel(row.id);

    await expect(live.restore.claimApply(row.id, row.projectId, row.organizationId)).resolves.toBe(
      "state_changed",
    );
    expect(await live.restore.findById(row.id)).toMatchObject({
      status: "prepared",
      cancelRequested: true,
    });
  });
});
