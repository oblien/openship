import { afterEach, describe, expect, it, vi } from "vitest";
import { repos, seedOwner } from "../jobs/_harness";
import { seedClusterProject } from "../../helpers/cluster-project";
import { ClusterDatabaseAdapter } from "@repo/adapters";
import type { ClusterDatabaseObservation, ClusterDatabaseRestoreSource } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import * as target from "@repo/platform/engine/lib/cluster-deployment-target";
import * as storage from "@repo/platform/engine/lib/cluster-backup-storage";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { runClusterDatabase } from "@repo/platform/engine/modules/projects/cluster-database.operations";

const verified: ClusterDatabaseObservation = {
  ready: true,
  message: "Verified fixture",
  observedAt: new Date().toISOString(),
  primary: "database-0",
  pods: [],
  volumes: [],
};

async function fixture(format: ClusterDatabaseRestoreSource["format"], restored: boolean) {
  const owner = await seedOwner();
  const project = await seedClusterProject(owner);
  const destinationId = crypto.randomUUID();
  await repos.backupDestination.create({
    id: destinationId,
    organizationId: owner.orgId,
    name: "Original recovery source",
    kind: "s3_compatible",
    bucket: "recovery-source",
    accessKeyIdEnc: "unused-after-recovery",
    secretAccessKeyEnc: "unused-after-recovery",
  });
  const { row } = await repos.clusterDatabase.start({
    organizationId: owner.orgId,
    projectId: project.id,
    clusterId: project.clusterId!,
    runtimeId: project.runtime.id,
    requestId: crypto.randomUUID(),
    name: "recovered-database",
    config: {
      engine: format === "redis-rdb-set" ? "redis" : "postgres",
      mode: "standalone",
      instances: 1,
      storageClass: "openship-local",
      storageGiB: 1,
      cpuMillis: 250,
      memoryMiB: 256,
      databaseName: "app",
    },
    secretEncrypted: encrypt("retained-database-password"),
    restoreSource: {
      format,
      databaseId: "original-database-already-removed",
      backupName: "saved-archive",
      backupId: "original/manifest.json",
      destinationId,
      destinationPath: "s3://recovery-source/openship/databases",
      serverName: "original",
      endpoint: null,
    },
  });
  if (restored)
    await repos.clusterDatabase.progress(row.id, row.generation, {
      steps: [
        {
          id: "restore",
          status: "completed",
          message: "Recovered",
          startedAt: null,
          finishedAt: new Date().toISOString(),
        },
      ],
      logs: [],
    });
  const api = { dispose: vi.fn(async () => {}) };
  vi.spyOn(target, "openClusterApi").mockResolvedValue({
    api,
    runtime: project.runtime,
    gateway: project.plan.hosts[0],
    target: {},
    edgeSourceIps: [],
  } as never);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "preflight").mockResolvedValue(undefined);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "operators").mockResolvedValue(undefined);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "storage").mockResolvedValue(undefined);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "needsRedisResize").mockResolvedValue(false);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "apply").mockResolvedValue(undefined);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "observe").mockResolvedValue(verified);
  const verify = vi.spyOn(ClusterDatabaseAdapter.prototype, "verify").mockResolvedValue(verified);
  const restore = vi
    .spyOn(ClusterDatabaseAdapter.prototype, "restore")
    .mockResolvedValue(undefined);
  vi.spyOn(ClusterDatabaseAdapter.prototype, "releaseRestorePin").mockResolvedValue(undefined);
  const resolveStorage = vi
    .spyOn(storage, "resolveClusterBackupStorage")
    .mockRejectedValue(new Error("The original recovery destination is unavailable"));
  const ctx = {
    organizationId: owner.orgId,
    userId: owner.userId,
    role: "owner",
  } as ExecutionContext;
  return { owner, row, ctx, verify, restore, resolveStorage };
}

afterEach(() => vi.restoreAllMocks());

describe("durable database recovery checkpoints", () => {
  it.each(["redis-rdb-set", "postgres-logical", "backup-artifact"] as const)(
    "does not replay completed %s recovery while changing resources",
    async (format) => {
      const f = await fixture(format, true);
      await repos.clusterDatabase.finish(f.row.id, f.row.generation, "ready", verified, null);
      const ready = await repos.clusterDatabase.get(f.owner.orgId, f.row.projectId, f.row.id);
      const changed = await repos.clusterDatabase.change(
        f.owner.orgId,
        f.row.projectId,
        f.row.id,
        ready.sequence,
        "apply",
        { config: { ...ready.config, memoryMiB: 512 } },
      );
      await runClusterDatabase(f.ctx, changed);
      const result = await repos.clusterDatabase.get(f.owner.orgId, f.row.projectId, f.row.id);
      expect(result).toMatchObject({ status: "ready", error: null, config: { memoryMiB: 512 } });
      expect(result.restoreSource).toEqual(f.row.restoreSource);
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.resolveStorage).not.toHaveBeenCalled();
      expect(f.verify).toHaveBeenCalled();
    },
  );

  it("retries verification without reloading data after recovery completed", async () => {
    const f = await fixture("redis-rdb-set", true);
    f.verify.mockRejectedValueOnce(new Error("Private connection unavailable"));
    await runClusterDatabase(
      f.ctx,
      await repos.clusterDatabase.get(f.owner.orgId, f.row.projectId, f.row.id),
    );
    const failed = await repos.clusterDatabase.get(f.owner.orgId, f.row.projectId, f.row.id);
    expect(failed).toMatchObject({ status: "failed", error: "Private connection unavailable" });
    const retried = await repos.clusterDatabase.change(
      f.owner.orgId,
      f.row.projectId,
      f.row.id,
      failed.sequence,
      "retry",
    );
    await runClusterDatabase(f.ctx, retried);
    expect(await repos.clusterDatabase.get(f.owner.orgId, f.row.projectId, f.row.id)).toMatchObject(
      { status: "ready", error: null },
    );
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.resolveStorage).not.toHaveBeenCalled();
  });

  it("still requires the recovery source when no completed checkpoint exists", async () => {
    const f = await fixture("redis-rdb-set", false);
    await runClusterDatabase(f.ctx, f.row);
    expect(await repos.clusterDatabase.get(f.owner.orgId, f.row.projectId, f.row.id)).toMatchObject(
      {
        status: "failed",
        error: "The original recovery destination is unavailable",
      },
    );
    expect(f.resolveStorage).toHaveBeenCalledOnce();
    expect(f.restore).not.toHaveBeenCalled();
  });
});
