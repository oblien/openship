import { AppError, type ClusterVolumeSnapshot } from "@repo/core";
import { createHash } from "node:crypto";
import { repos } from "@repo/db";
import { ClusterVolumeAdapter } from "@repo/adapters";
import { ProjectVolumeSchemas } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import { openClusterApi } from "../../lib/cluster-deployment-target";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { clusterStorageLock } from "../../lib/cluster-storage-lock";
import { fleetAdmin } from "../system/managed-network.operations";
import {
  assertClusterManagementAvailable,
  authorizeMember,
} from "../system/server-cluster.operations";
import { authorization } from "../../lib/authorization";
import { createRunBus } from "../../lib/run-bus";
import { durableRunEvents } from "../../lib/durable-run-events";

const volumeBus = createRunBus<void>(() => false);
const topic = (ctx: ExecutionContext, id: string) => JSON.stringify([ctx.organizationId, id]);

async function volumeSnapshot(
  ctx: ExecutionContext,
  projectId: string,
  signal?: AbortSignal,
): Promise<ClusterVolumeSnapshot> {
  assertClusterManagementAvailable();
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.clusterId) return { volumes: [], backups: [] };
  const storage = await repos.clusterStorage.get(ctx.organizationId, project.clusterId);
  if (!storage || storage.status === "removed") return { volumes: [], backups: [] };
  const connection = await openClusterApi(ctx.organizationId, project.clusterId, storage.runtimeId);
  try {
    const adapter = new ClusterVolumeAdapter(
      connection.api,
      projectId,
      storage.runtimeId,
      AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      async () => {
        throw new Error("Inspection cannot change volumes.");
      },
      connection.runtime.plan.hosts,
    );
    const backups = await adapter.archive.list();
    const volumes = await adapter.list(backups);
    return { volumes, backups };
  } finally {
    await connection.api.dispose();
  }
}

export function createClusterVolumeOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): ResourceServices<typeof ProjectVolumeSchemas> {
  const run = async <T>(
    ctx: ExecutionContext,
    projectId: string,
    mutate: boolean,
    work: (adapter: ClusterVolumeAdapter) => Promise<T>,
  ): Promise<T> => {
    assertClusterManagementAvailable();
    if (mutate) await fleetAdmin(ctx);
    const operate = async () => {
      const project = await repos.project.findById(projectId);
      assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
      if (!project.clusterId || project.deletionInProgress)
        throw new AppError(
          "Choose an available server cluster for this project first.",
          409,
          "CLUSTER_TARGET_REQUIRED",
        );
      const execute = async () => {
        const storage = await repos.clusterStorage.get(ctx.organizationId, project.clusterId!);
        if (!storage || (mutate && storage.status !== "ready"))
          throw new AppError(
            "Enable shared storage on this cluster before managing project volumes.",
            409,
            "CLUSTER_STORAGE_REQUIRED",
          );
        const connection = await openClusterApi(
          ctx.organizationId,
          project.clusterId!,
          storage.runtimeId,
        );
        try {
          if (mutate)
            for (const host of connection.runtime.plan.hosts)
              await authorizeMember(ctx, host.serverId);
          const fence = async () => {
            if (!mutate) throw new Error("Volume inspection cannot change data.");
            const current = await repos.clusterStorage.get(ctx.organizationId, project.clusterId!);
            if (current?.status !== "ready" || current.id !== storage.id)
              throw new AppError(
                "Storage is changing. Wait for its operation to finish.",
                409,
                "CLUSTER_STORAGE_CONFLICT",
              );
          };
          return await work(
            new ClusterVolumeAdapter(
              connection.api,
              projectId,
              storage.runtimeId,
              AbortSignal.timeout(90_000),
              fence,
              connection.runtime.plan.hosts,
            ),
          );
        } finally {
          await connection.api.dispose();
        }
      };
      return mutate
        ? clusterStorageLock(ctx.organizationId, project.clusterId).run(execute)
        : execute();
    };
    if (!mutate) return operate();
    const result = await withLiveProjectRuntimeMutation(projectId, operate);
    if (result === undefined)
      throw new AppError("The project is being removed.", 409, "PROJECT_UNAVAILABLE");
    return result;
  };
  const audit = (ctx: ExecutionContext, id: string, name: string, action: string) => {
    volumeBus.publish(topic(ctx, id), undefined);
    recordAudit(ctx, {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: `volume.${action}`, name },
    });
  };
  return {
    listClusterVolumes: async (ctx, id) => (await volumeSnapshot(ctx, id)).volumes,
    listClusterVolumeBackups: async (ctx, id) => (await volumeSnapshot(ctx, id)).backups,
    async createClusterVolume(ctx, id, input) {
      const value = await run(ctx, id, true, (a) => a.create(input));
      audit(ctx, id, input.name, "created");
      return value;
    },
    async resizeClusterVolume(ctx, id, input) {
      const value = await run(ctx, id, true, (a) =>
        a.resize(input.name, input.resourceVersion, input.sizeGiB),
      );
      audit(ctx, id, input.name, "resized");
      return value;
    },
    async backupClusterVolume(ctx, id, input) {
      const value = await run(ctx, id, true, (a) => a.backup(input.name, input.requestId));
      audit(ctx, id, input.name, "backup");
      return value;
    },
    async scheduleClusterVolumeBackups(ctx, id, input) {
      const value = await run(ctx, id, true, (a) =>
        a.schedule(input.name, input.resourceVersion, input.schedule),
      );
      audit(ctx, id, input.name, "backup_schedule");
      return value;
    },
    async removeClusterVolumeBackup(ctx, id, input) {
      if (input.confirmName !== input.backupName)
        throw new AppError(
          "Confirm the file backup name before deleting its archive.",
          422,
          "CLUSTER_VOLUME_CONFIRMATION",
        );
      await run(ctx, id, true, (a) => a.archive.remove(input.backupName));
      audit(ctx, id, input.backupName, "backup_deleted");
      return { removed: true };
    },
    async removeClusterVolume(ctx, id, input) {
      if (input.name !== input.confirmName)
        throw new AppError(
          "Enter the volume name to confirm deleting its data.",
          422,
          "CLUSTER_VOLUME_CONFIRMATION",
        );
      const value = await run(ctx, id, true, async (a) => {
        const project = await repos.project.findById(id);
        if (project?.clusterConfig?.mounts?.some((m) => m.name === input.name))
          throw new AppError(
            "Disconnect this volume and deploy the application before deleting its data.",
            409,
            "CLUSTER_VOLUME_ATTACHED",
          );
        return a.remove(input.name, input.resourceVersion);
      });
      audit(ctx, id, input.name, "deleted");
      return value;
    },
  };
}

/** Native storage controllers keep reconciling while OpenShip is offline. SSE
 * reconnects observe their current state and never repeat a storage mutation. */
export async function* clusterVolumeEvents(
  ctx: ExecutionContext,
  projectId: string,
  signal?: AbortSignal,
) {
  yield* durableRunEvents({
    signal,
    load: async () => {
      await authorization.authorize(ctx, {
        resourceType: "project",
        resourceId: projectId,
        action: "read",
      });
      return volumeSnapshot(ctx, projectId, signal);
    },
    subscribe: (changed) => volumeBus.subscribe(topic(ctx, projectId), changed),
    version: (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    complete: () => false,
  });
}
