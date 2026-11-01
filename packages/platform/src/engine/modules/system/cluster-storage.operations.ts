import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { AppError, validateClusterStorage, type ClusterStorageStep } from "@repo/core";
import { repos, type ClusterStorageRecord } from "@repo/db";
import { ClusterStorageAdapter, prepareStorageHost } from "@repo/adapters";
import { ClusterStorageCollectionSchemas, type ClusterStorage } from "@repo/contracts";
import type { ScopedServices } from "../../../resource-operations";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import {
  openClusterApi,
  requireClusterDeploymentTarget,
} from "../../lib/cluster-deployment-target";
import { resolveClusterBackupStorage } from "../../lib/cluster-backup-storage";
import { createProvisionLock } from "../../lib/provision-lock";
import { clusterStorageLock } from "../../lib/cluster-storage-lock";
import { fleetAdmin } from "./managed-network.operations";
import {
  authorizeMember,
  onServer,
  record,
  assertClusterManagementAvailable,
} from "./server-cluster.operations";
import {
  appendNetworkSetupLog,
  networkSetupMessage,
  updateNetworkSetupStep,
} from "./network-setup-progress";
import { assertNetworkSetupAcceptingWork, deferNetworkSetupWork } from "./network-setup-lifecycle";
import { notifyNetworkSetup } from "./network-setup-bus";

export function presentClusterStorage(row: ClusterStorageRecord): ClusterStorage {
  return {
    id: row.id,
    clusterId: row.clusterId,
    runtimeId: row.runtimeId,
    config: row.config,
    status: row.status,
    intent: row.intent,
    generation: row.generation,
    sequence: row.sequence,
    progress: row.progress,
    observation: row.observation,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function runClusterStorage(
  ctx: ExecutionContext,
  row: ClusterStorageRecord,
  parentSignal?: AbortSignal,
) {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    cancelled.signal,
    AbortSignal.timeout(40 * 60_000),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  const progress = structuredClone(row.progress);
  let current: ClusterStorageStep = row.intent === "remove" ? "remove" : "prerequisites";
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(progress);
    writes = writes.then(async () => {
      await repos.clusterStorage.progress(row.id, row.generation, snapshot);
      notifyNetworkSetup(ctx.organizationId, "storage", row.clusterId);
    });
    return writes;
  };
  const active = async () => {
    signal.throwIfAborted();
    await fleetAdmin(ctx);
    if (!(await repos.clusterStorage.active(row.id, row.generation)))
      throw new AppError(
        "Storage setup is now owned by another operation.",
        409,
        "CLUSTER_STORAGE_EXPIRED",
      );
  };
  const log = async (message: string) => {
    appendNetworkSetupLog(progress, current, { message, level: "info" });
    await persist();
  };
  const step = async <T>(id: ClusterStorageStep, message: string, work: () => Promise<T>) => {
    current = id;
    await active();
    updateNetworkSetupStep(progress, id, "running", message);
    await persist();
    const result = await work();
    updateNetworkSetupStep(progress, id, "completed", message);
    await persist();
    return result;
  };
  let heartbeats = Promise.resolve();
  const timer = setInterval(() => {
    heartbeats = heartbeats
      .then(async () => {
        if (!signal.aborted && !(await repos.clusterStorage.heartbeat(row.id, row.generation)))
          cancelled.abort();
      })
      .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/system/cluster-storage.operations"); return cancelled.abort(); });
  }, 20_000);
  timer.unref();
  let connection: Awaited<ReturnType<typeof openClusterApi>> | undefined;
  try {
    connection = await openClusterApi(ctx.organizationId, row.clusterId, row.runtimeId);
    const hosts = connection.runtime.plan.hosts;
    for (const host of hosts) await authorizeMember(ctx, host.serverId);
    const adapter = new ClusterStorageAdapter(
      connection.api,
      row.runtimeId,
      row.config,
      hosts,
      signal,
      active,
    );
    let observation = null;
    if (row.intent === "remove")
      await step("remove", "Removing the empty managed storage installation.", () =>
        adapter.remove(log),
      );
    else {
      await step(
        "prerequisites",
        "Preparing volume tools and checking the selected data directories.",
        async () => {
          for (const host of hosts) {
            await active();
            await createProvisionLock(`provision:server:${host.serverId}`).run(
              () =>
                onServer(ctx, host.serverId, async (executor) => {
                  await prepareStorageHost(
                    executor,
                    row.runtimeId,
                    row.config.disks.find((d) => d.serverId === host.serverId),
                    (entry) => {
                      appendNetworkSetupLog(progress, current, {
                        ...entry,
                        message: `${host.name}: ${entry.message}`,
                      });
                      void persist().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/system/cluster-storage.operations"); return cancelled.abort(); });
                    },
                    signal,
                  );
                }),
              signal,
            );
          }
          await writes;
        },
      );
      await step("install", "Installing storage management and volume drivers.", () =>
        adapter.install(log),
      );
      await step(
        "disks",
        "Configuring the reviewed storage disks and independent copies.",
        async () => {
          await adapter.disks(log);
          if (row.config.backupDestinationId)
            await adapter.backupDestination(
              await resolveClusterBackupStorage(ctx, row.config.backupDestinationId),
            );
        },
      );
      observation = await step(
        "verify",
        "Verifying disk health and volume attachment on every server.",
        () => adapter.verify(log),
      );
    }
    await active();
    if (await repos.clusterStorage.finish(row.id, row.generation, progress, observation, null))
      notifyNetworkSetup(ctx.organizationId, "storage", row.clusterId);
  } catch (error) {
    observeCaughtError(error, "platform/engine/modules/system/cluster-storage.operations");
    const message = networkSetupMessage(error instanceof Error ? error.message : String(error));
    updateNetworkSetupStep(progress, current, "failed", message);
    await writes.catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/system/cluster-storage.operations");
    });
    await repos.clusterStorage
      .finish(row.id, row.generation, progress, null, message)
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/system/cluster-storage.operations");
      });
    notifyNetworkSetup(ctx.organizationId, "storage", row.clusterId);
  } finally {
    clearInterval(timer);
    await heartbeats;
    await connection?.api.dispose();
  }
}
async function queue(ctx: ExecutionContext, row: ClusterStorageRecord) {
  await deferNetworkSetupWork(
    {
      kind: "storage",
      organizationId: ctx.organizationId,
      id: row.id,
      clusterId: row.clusterId,
      generation: row.generation,
    },
    (signal) => runClusterStorage(ctx, row, signal),
  );
  notifyNetworkSetup(ctx.organizationId, "storage", row.clusterId);
}
export const clusterStorageCollection = {
  async getClusterStorage(ctx, input) {
    assertClusterManagementAvailable();
    await authorization.authorize(ctx, {
      resourceType: "server",
      resourceId: "*",
      action: "read",
      scope: "all",
    });
    await repos.computeCluster.get(ctx.organizationId, input.clusterId);
    let row = await repos.clusterStorage.get(ctx.organizationId, input.clusterId);
    if (!row) return null;
    if (input.observe && row.status === "ready") {
      const connection = await openClusterApi(ctx.organizationId, input.clusterId, row.runtimeId);
      try {
        const observation = await new ClusterStorageAdapter(
          connection.api,
          row.runtimeId,
          row.config,
          connection.runtime.plan.hosts,
          AbortSignal.timeout(30_000),
          async () => {
            throw new Error("Inspection cannot change storage.");
          },
        ).observe();
        row = { ...row, observation };
      } finally {
        await connection.api.dispose();
      }
    }
    return presentClusterStorage(row);
  },
  async setupClusterStorage(ctx, input) {
    await fleetAdmin(ctx);
    assertNetworkSetupAcceptingWork();
    validateClusterStorage(input.config);
    const { runtime } = await requireClusterDeploymentTarget(ctx.organizationId, input.clusterId);
    if (runtime.provider !== "k3s") throw new AppError("Shared cluster storage requires Kubernetes. Swarm services use named volumes on their connected manager.", 422, "CLUSTER_PROVIDER_UNSUPPORTED");
    for (const host of runtime.plan.hosts) await authorizeMember(ctx, host.serverId);
    if (input.config.backupDestinationId)
      await resolveClusterBackupStorage(ctx, input.config.backupDestinationId);
    const { row, started } = await repos.clusterStorage.start({
      ...input,
      runtimeId: runtime.id,
      organizationId: ctx.organizationId,
    });
    if (started) {
      await queue(ctx, row);
      record(ctx, input.clusterId, "storage.setup");
    }
    return presentClusterStorage(row);
  },
  async retryClusterStorage(ctx, input) {
    await fleetAdmin(ctx);
    assertNetworkSetupAcceptingWork();
    const row = await clusterStorageLock(ctx.organizationId, input.clusterId).run(() =>
      repos.clusterStorage.change(ctx.organizationId, input.clusterId, input.sequence, "retry"),
    );
    await queue(ctx, row);
    record(ctx, input.clusterId, "storage.retry");
    return presentClusterStorage(row);
  },
  async configureClusterStorageBackup(ctx, input) {
    await fleetAdmin(ctx);
    assertNetworkSetupAcceptingWork();
    await resolveClusterBackupStorage(ctx, input.destinationId);
    const row = await clusterStorageLock(ctx.organizationId, input.clusterId).run(() =>
      repos.clusterStorage.configureBackup(
        ctx.organizationId,
        input.clusterId,
        input.sequence,
        input.destinationId,
      ),
    );
    await queue(ctx, row);
    record(ctx, input.clusterId, "storage.backups");
    return presentClusterStorage(row);
  },
  async removeClusterStorage(ctx, input) {
    await fleetAdmin(ctx);
    assertNetworkSetupAcceptingWork();
    const row = await clusterStorageLock(ctx.organizationId, input.clusterId).run(() =>
      repos.clusterStorage.change(ctx.organizationId, input.clusterId, input.sequence, "remove"),
    );
    await queue(ctx, row);
    record(ctx, input.clusterId, "storage.remove");
    return presentClusterStorage(row);
  },
} satisfies ScopedServices<typeof ClusterStorageCollectionSchemas>;
