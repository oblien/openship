import { randomBytes, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AppError,
  clusterDatabasePodCount,
  validateClusterDatabase,
  clusterPostgresVersion,
  type ClusterDatabaseStep,
  type ClusterDatabaseRestoreSource,
  type ClusterDatabaseObservation,
} from "@repo/core";
import { repos, type ClusterDatabaseRecord } from "@repo/db";
import {
  ClusterDatabaseAdapter,
  clusterDatabaseHosts,
  clusterDatabaseUrl,
  clusterDatabaseNamespace,
  databaseArchiveName,
  type ClusterDatabaseBackupStorage,
} from "@repo/adapters";
import { ProjectDatabaseSchemas, type ClusterDatabase } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ExecutionContext } from "../../../context";
import type { ProjectDependencies } from "../../../projects";
import { authorization } from "../../lib/authorization";
import { durableRunEvents } from "../../lib/durable-run-events";
import { assertResourceInOrg } from "../../lib/resource-access";
import {
  openClusterApi,
  requireClusterDeploymentTarget,
} from "../../lib/cluster-deployment-target";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { decrypt, encrypt } from "../../lib/encryption";
import { resolveClusterBackupStorage as backupStorage } from "../../lib/cluster-backup-storage";
import { fleetAdmin } from "../system/managed-network.operations";
import {
  assertClusterManagementAvailable,
  authorizeMember,
} from "../system/server-cluster.operations";
import {
  assertNetworkSetupAcceptingWork,
  deferNetworkSetupWork,
} from "../system/network-setup-lifecycle";
import {
  updateNetworkSetupStep,
  appendNetworkSetupLog,
  networkSetupMessage,
} from "../system/network-setup-progress";
import {
  clusterDatabaseBus,
  clusterDatabaseTopic,
  notifyClusterDatabase,
} from "./cluster-database.events";
import { databaseImportSource, listDatabaseImports } from "./cluster-database-import";
import { withBackupRunLock } from "../backups/backup-lock";

export function presentClusterDatabase(row: ClusterDatabaseRecord): ClusterDatabase {
  return {
    id: row.id,
    projectId: row.projectId,
    clusterId: row.clusterId,
    name: row.name,
    config: row.config,
    status: row.status,
    intent: row.intent,
    sequence: row.sequence,
    generation: row.generation,
    progress: row.progress,
    observation: row.observation,
    error: row.error,
    envKey: row.envKey,
    sourceDatabaseId:
      row.restoreSource && row.restoreSource.format !== "backup-artifact"
        ? row.restoreSource.databaseId
        : null,
    ...clusterDatabaseHosts(row.id, row.config),
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
async function project(ctx: ExecutionContext, id: string) {
  assertClusterManagementAvailable();
  const row = await repos.project.findById(id);
  assertResourceInOrg(row, "Project", ctx.organizationId, id);
  return row;
}
const safe = (error: unknown) =>
  networkSetupMessage(error instanceof Error ? error.message : String(error));
function retainedObservation(observation: ClusterDatabaseObservation): ClusterDatabaseObservation {
  return {
    ...observation,
    ready: false,
    message: observation.volumes.length
      ? "The database is stopped and its persistent data is retained."
      : "The database is stopped. No retained volume claims were found.",
    ...(observation.archive
      ? {
          archive: {
            ...observation.archive,
            healthy: null,
            message: "The database is stopped; scheduled backups are paused.",
          },
        }
      : {}),
  };
}

export async function runClusterDatabase(
  ctx: ExecutionContext,
  row: ClusterDatabaseRecord,
  parentSignal?: AbortSignal,
) {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    cancelled.signal,
    AbortSignal.timeout(30 * 60_000),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  const progress = structuredClone(row.progress);
  const active = async () => {
    signal.throwIfAborted();
    await fleetAdmin(ctx);
    if (!(await repos.clusterDatabase.active(row.id, row.generation)))
      throw new AppError(
        "This database worker no longer owns the operation. Reload its saved progress.",
        409,
        "CLUSTER_DATABASE_EXPIRED",
      );
  };
  let writes = Promise.resolve();
  const persist = () => {
    const copy = structuredClone(progress);
    writes = writes.then(async () => {
      await repos.clusterDatabase.progress(row.id, row.generation, copy);
      notifyClusterDatabase(ctx.organizationId, row.projectId);
    });
    return writes;
  };
  let current: ClusterDatabaseStep = row.intent === "remove" ? "remove" : "connect";
  const log = async (message: string) => {
    appendNetworkSetupLog(progress, current, { message, level: "info" });
    await persist();
  };
  const step = async <T>(id: ClusterDatabaseStep, message: string, work: () => Promise<T>) => {
    current = id;
    await active();
    updateNetworkSetupStep(progress, id, "running", message);
    await persist();
    const result = await work();
    updateNetworkSetupStep(progress, id, "completed", message);
    await persist();
    return result;
  };
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (!signal.aborted && !(await repos.clusterDatabase.heartbeat(row.id, row.generation)))
          cancelled.abort();
      })
      .catch(() => cancelled.abort());
  }, 20_000);
  timer.unref();
  let connection: Awaited<ReturnType<typeof openClusterApi>> | undefined;
  try {
    await step(
      "connect",
      "Checking the saved cluster identity and private API connection.",
      async () => {
        const p = await project(ctx, row.projectId);
        if ((p.clusterId && p.clusterId !== row.clusterId) || p.workspaceId)
          throw new Error("The project no longer targets this database's cluster.");
        connection = await openClusterApi(ctx.organizationId, row.clusterId, row.runtimeId);
        for (const host of connection.runtime.plan.hosts) await authorizeMember(ctx, host.serverId);
      },
    );
    const adapter = new ClusterDatabaseAdapter(
      connection!.api,
      {
        ...row,
        hosts: connection!.runtime.plan.hosts,
        ...(row.intent !== "remove" && row.config.backup
          ? { backupStorage: await backupStorage(ctx, row.config.backup.destinationId) }
          : {}),
        ...(row.intent === "apply" && row.restoreSource
          ? {
              restoreStorage: await backupStorage(
                ctx,
                row.restoreSource.destinationId,
                row.restoreSource,
              ),
            }
          : {}),
      },
      signal,
      active,
    );
    if (row.intent === "remove") {
      await step(
        "remove",
        row.deleteData
          ? "Removing the database and explicitly selected persistent data."
          : "Stopping the database and retaining its persistent data.",
        () => adapter.remove(row.deleteData, log),
      );
      const observation = row.deleteData ? null : retainedObservation(await adapter.observe());
      if (row.deleteData) await adapter.releaseRestorePin();
      await repos.clusterDatabase.finish(
        row.id,
        row.generation,
        row.deleteData ? "deleted" : "retained",
        observation,
        null,
      );
    } else if (row.intent === "backup") {
      if (!row.backupRequestId) throw new Error("The saved database backup request is missing.");
      await step("backup", "Saving the database at the backup destination.", () =>
        adapter.archive.run(row.backupRequestId!, row.generation, log),
      );
      const observation = await adapter.observe();
      await repos.clusterDatabase.finish(row.id, row.generation, "ready", observation, null);
    } else {
      await adapter.preflight();
      await step("operators", "Preparing database management and checking that it is ready.", () =>
        adapter.operators(log),
      );
      await step("storage", "Preparing persistent storage for each database instance.", () =>
        adapter.storage(log),
      );
      if (await adapter.needsRedisResize())
        await step(
          "backup",
          "Verifying a recovery point before moving Redis data between servers.",
          () => adapter.backupBeforeRedisResize(log),
        );
      await step("database", "Applying the database configuration and private access rules.", () =>
        adapter.apply(decrypt(row.secretEncrypted)),
      );
      let observation = await step(
        "verify",
        "Checking database instances, volumes and an authenticated private connection.",
        () => adapter.verify(log),
      );
      if (
        row.restoreSource &&
        ["redis-rdb-set", "postgres-logical", "backup-artifact"].includes(
          row.restoreSource.format ?? "",
        )
      ) {
        const loaded = row.progress.steps.some(
          (item) => item.id === "restore" && item.status === "completed",
        );
        await step("restore", "Recovering the saved data into this new database.", async () => {
          if (!loaded && row.restoreSource?.format === "postgres-logical") {
            const source = await repos.clusterDatabase.get(
              ctx.organizationId,
              row.projectId,
              row.restoreSource.databaseId,
            );
            if (
              source.status !== "ready" ||
              !isDeepStrictEqual(source.config, row.restoreSource.sourceConfig)
            )
              throw new Error(
                "The original database changed while its copy was being prepared. Keep its saved settings until recovery finishes.",
              );
            const sourceAdapter = new ClusterDatabaseAdapter(
              connection!.api,
              {
                ...source,
                hosts: connection!.runtime.plan.hosts,
                backupStorage: await backupStorage(
                  ctx,
                  row.restoreSource.destinationId,
                  row.restoreSource,
                ),
              },
              signal,
              active,
            );
            await sourceAdapter.dataTasks.secret(
              "backup-destination",
              await backupStorage(ctx, row.restoreSource.destinationId, row.restoreSource),
            );
            await sourceAdapter.dataTasks.run(row.requestId, source.generation, log, row.requestId);
          }
          await adapter.restore(log);
        });
        observation = await step(
          "verify",
          "Verifying the recovered database and its private connection.",
          () => adapter.verify(log, "restored"),
        );
        await adapter.releaseRestorePin();
      }
      if (row.config.backup) {
        await adapter.archive.schedule(row.config.backup);
        await step(
          "backup",
          "Verifying the first database backup at the selected destination.",
          () => adapter.archive.run("initial", row.generation, log),
        );
        observation = await adapter.observe();
      }
      await repos.clusterDatabase.finish(row.id, row.generation, "ready", observation, null);
    }
  } catch (error) {
    if (await repos.clusterDatabase.active(row.id, row.generation)) {
      const message = safe(error);
      updateNetworkSetupStep(progress, current, "failed", message);
      await persist().catch(() => {});
      await repos.clusterDatabase.finish(row.id, row.generation, "failed", null, message);
    }
  } finally {
    clearInterval(timer);
    cancelled.abort();
    await heartbeat;
    await connection?.api.dispose();
    notifyClusterDatabase(ctx.organizationId, row.projectId);
  }
}

async function queue(ctx: ExecutionContext, row: ClusterDatabaseRecord) {
  await deferNetworkSetupWork(
    {
      kind: "database",
      organizationId: ctx.organizationId,
      id: row.id,
      projectId: row.projectId,
      generation: row.generation,
    },
    (signal) => runClusterDatabase(ctx, row, signal),
  );
  notifyClusterDatabase(ctx.organizationId, row.projectId);
}
export function createClusterDatabaseOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): ResourceServices<typeof ProjectDatabaseSchemas> {
  const audit = (ctx: ExecutionContext, id: string, databaseId: string, action: string) =>
    recordAudit(ctx, {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: `database.${action}`, databaseId },
    });
  const change = async (
    ctx: ExecutionContext,
    id: string,
    input: {
      databaseId: string;
      expectedSequence: number;
      config?: import("@repo/core").ClusterDatabaseConfig;
      confirmRedisRebalance?: boolean;
      deleteData?: boolean;
      name?: string;
    },
    action: "apply" | "retry" | "remove" | "backup",
  ) => {
    await fleetAdmin(ctx);
    assertNetworkSetupAcceptingWork();
    const result = await withLiveProjectRuntimeMutation(id, async () => {
      await project(ctx, id);
      const current = await repos.clusterDatabase.get(ctx.organizationId, id, input.databaseId);
      if (input.config?.backup) await backupStorage(ctx, input.config.backup.destinationId);
      if (action === "remove" && input.name !== current.name)
        throw new AppError(
          "Enter the database name to confirm removal.",
          422,
          "CLUSTER_DATABASE_CONFIRMATION",
        );
      const row = await repos.clusterDatabase.change(
        ctx.organizationId,
        id,
        input.databaseId,
        input.expectedSequence,
        action,
        input,
      );
      await queue(ctx, row);
      audit(ctx, id, row.id, action);
      return presentClusterDatabase(row);
    });
    if (!result) throw new AppError("The project is being removed.", 409, "PROJECT_UNAVAILABLE");
    return result;
  };
  return {
    async listClusterDatabases(ctx, id) {
      await project(ctx, id);
      return (await repos.clusterDatabase.list(ctx.organizationId, id)).map(presentClusterDatabase);
    },
    async listClusterDatabaseImports(ctx, id) {
      await project(ctx, id);
      return listDatabaseImports(ctx, id);
    },
    async getClusterDatabase(ctx, id, input) {
      await project(ctx, id);
      let row = await repos.clusterDatabase.get(ctx.organizationId, id, input.databaseId);
      if (input.observe && (row.status === "ready" || row.status === "retained")) {
        const connection = await openClusterApi(ctx.organizationId, row.clusterId, row.runtimeId);
        try {
          const adapter = new ClusterDatabaseAdapter(
            connection.api,
            { ...row, hosts: connection.runtime.plan.hosts },
            AbortSignal.timeout(30_000),
            async () => {
              throw new Error("Status reads cannot mutate the database.");
            },
          );
          const current = await adapter.observe();
          const observation = row.status === "retained" ? retainedObservation(current) : current;
          await repos.clusterDatabase.observe(
            ctx.organizationId,
            id,
            row.id,
            row.generation,
            observation,
          );
          row = await repos.clusterDatabase.get(ctx.organizationId, id, row.id);
        } finally {
          await connection.api.dispose();
        }
      }
      return presentClusterDatabase(row);
    },
    async createClusterDatabase(ctx, id, input) {
      await fleetAdmin(ctx);
      assertNetworkSetupAcceptingWork();
      validateClusterDatabase(input.config);
      if ([input.restoreFrom, input.importFrom, input.copyFrom].filter(Boolean).length > 1)
        throw new AppError(
          "Choose one source for the new database.",
          422,
          "CLUSTER_DATABASE_RESTORE_TARGET",
        );
      if (
        input.config.engine === "redis" &&
        input.config.mode === "cluster" &&
        !input.clusterAwareClient
      )
        throw new AppError(
          "Redis Cluster needs a cluster-aware client. Confirm that the application supports it.",
          422,
          "CLUSTER_DATABASE_CLIENT_REQUIRED",
        );
      const result = await withLiveProjectRuntimeMutation(id, async () => {
        const admit = async () => {
          const p = await project(ctx, id);
          const clusterId = input.clusterId ?? p.clusterId;
          if (
            !clusterId ||
            (p.clusterId && p.clusterId !== clusterId) ||
            p.workspaceId ||
            p.appTemplateId === "openship"
          )
            throw new AppError(
              "Choose a ready server cluster for this database.",
              409,
              "CLUSTER_TARGET_REQUIRED",
            );
          const existing = await repos.clusterDatabase.findByRequest(
            ctx.organizationId,
            id,
            input.requestId,
          );
          if (existing) {
            const source = existing.restoreSource;
            const sameSource = input.importFrom
              ? source?.backupRunId === input.importFrom.runId &&
                source.artifact?.name === input.importFrom.artifactName
              : input.copyFrom
                ? source?.format === "postgres-logical" &&
                  source.databaseId === input.copyFrom.databaseId &&
                  source.sourceSequence === input.copyFrom.expectedSequence
                : input.restoreFrom
                  ? source?.databaseId === input.restoreFrom.databaseId &&
                    source.backupName === input.restoreFrom.backupName
                  : !source;
            if (
              existing.name !== input.name ||
              existing.clusterId !== clusterId ||
              !isDeepStrictEqual(existing.config, input.config) ||
              !sameSource
            )
              throw new AppError(
                "This request already belongs to another database configuration.",
                409,
                "CLUSTER_DATABASE_CONFLICT",
              );
            return presentClusterDatabase(
              await repos.clusterDatabase.get(ctx.organizationId, id, existing.id),
            );
          }
          const { runtime } = await requireClusterDeploymentTarget(ctx.organizationId, clusterId);
          for (const host of runtime.plan.hosts) await authorizeMember(ctx, host.serverId);
          const count = clusterDatabasePodCount(input.config);
          if (runtime.plan.hosts.length < count)
            throw new AppError(
              `This database needs ${count} servers so each data instance can run on a separate server.`,
              422,
              "CLUSTER_DATABASE_CAPACITY",
            );
          if (input.config.backup) await backupStorage(ctx, input.config.backup.destinationId);
          let restoreSource: ClusterDatabaseRestoreSource | undefined;
          let sourceConnection: Awaited<ReturnType<typeof openClusterApi>> | undefined;
          let undoPin: (() => Promise<void>) | undefined;
          let saved = false;
          try {
            if (input.importFrom)
              restoreSource = await databaseImportSource(
                ctx,
                id,
                input.importFrom,
                input.config.engine,
              );
            if (input.restoreFrom || input.copyFrom) {
              const source = await repos.clusterDatabase.get(
                ctx.organizationId,
                id,
                (input.restoreFrom ?? input.copyFrom)!.databaseId,
              );
              if (
                source.config.engine !== input.config.engine ||
                !source.config.backup ||
                source.config.databaseName !== input.config.databaseName ||
                input.config.storageGiB < source.config.storageGiB ||
                source.clusterId !== clusterId ||
                source.runtimeId !== runtime.id
              )
                throw new AppError(
                  "Create the new database on this cluster, using the original database type and name, with enough storage.",
                  422,
                  "CLUSTER_DATABASE_RESTORE_TARGET",
                );
              if (input.copyFrom) {
                if (
                  source.config.engine !== "postgres" ||
                  source.status !== "ready" ||
                  source.sequence !== input.copyFrom.expectedSequence ||
                  Number(clusterPostgresVersion(input.config)) <
                    Number(clusterPostgresVersion(source.config))
                )
                  throw new AppError(
                    "Refresh the source database and choose the same or a newer PostgreSQL version.",
                    409,
                    "CLUSTER_DATABASE_RESTORE_TARGET",
                  );
                const storage = await backupStorage(ctx, source.config.backup.destinationId);
                const serverName = clusterDatabaseNamespace(source.id),
                  backupName = databaseArchiveName(input.requestId);
                restoreSource = {
                  format: "postgres-logical",
                  databaseId: source.id,
                  runtimeId: source.runtimeId,
                  sourceConfig: source.config,
                  sourceSequence: input.copyFrom.expectedSequence,
                  pinId: input.requestId,
                  backupName,
                  backupId: `${new URL(storage.destinationPath).pathname.slice(1)}/${serverName}/postgres/${backupName}/manifest.json`,
                  destinationId: storage.destinationId,
                  destinationPath: storage.destinationPath,
                  serverName,
                  endpoint: storage.endpoint,
                };
              } else {
                if (
                  source.config.engine === "postgres" &&
                  clusterPostgresVersion(source.config) !== clusterPostgresVersion(input.config)
                )
                  throw new AppError(
                    "Physical backups restore to the same PostgreSQL version. Use Create upgraded copy to move to a newer version.",
                    422,
                    "CLUSTER_DATABASE_RESTORE_TARGET",
                  );
                sourceConnection = await openClusterApi(
                  ctx.organizationId,
                  source.clusterId,
                  source.runtimeId,
                );
                const adapter = new ClusterDatabaseAdapter(
                  sourceConnection.api,
                  { ...source, hosts: sourceConnection.runtime.plan.hosts },
                  AbortSignal.timeout(30_000),
                  async () => {
                    await fleetAdmin(ctx);
                  },
                );
                restoreSource = await adapter.archive.restoreSource(
                  source.id,
                  source.config.backup.destinationId,
                  input.restoreFrom!.backupName,
                );
                restoreSource.runtimeId = source.runtimeId;
                await backupStorage(ctx, restoreSource.destinationId, restoreSource);
                if (restoreSource.format === "redis-rdb-set" && "pin" in adapter.archive) {
                  const archive = adapter.archive;
                  await archive.pin(input.restoreFrom!.backupName, input.requestId);
                  restoreSource.pinId = input.requestId;
                  undoPin = () => archive.pin(input.restoreFrom!.backupName, input.requestId, true);
                }
              }
            }
            const { row, started } = await repos.clusterDatabase.start({
              organizationId: ctx.organizationId,
              projectId: id,
              clusterId,
              runtimeId: runtime.id,
              requestId: input.requestId,
              name: input.name,
              config: input.config,
              restoreSource,
              secretEncrypted: encrypt(randomBytes(32).toString("hex")),
            });
            saved = true;
            if (started) {
              await queue(ctx, row);
              audit(ctx, id, row.id, "created");
            }
            return presentClusterDatabase(row);
          } catch (error) {
            // Do not undo a pin after an ambiguous database commit. Confirm that
            // no durable request exists before releasing its recovery point.
            if (!saved && undoPin) {
              try {
                if (
                  !(await repos.clusterDatabase.findByRequest(
                    ctx.organizationId,
                    id,
                    input.requestId,
                  ))
                )
                  await undoPin();
              } catch {}
            }
            throw error;
          } finally {
            await sourceConnection?.api.dispose();
          }
        };
        return input.importFrom ? withBackupRunLock(input.importFrom.runId, admit) : admit();
      });
      if (!result) throw new AppError("The project is being removed.", 409, "PROJECT_UNAVAILABLE");
      return result;
    },
    updateClusterDatabase: (ctx, id, input) => change(ctx, id, input, "apply"),
    retryClusterDatabase: (ctx, id, input) => change(ctx, id, input, "retry"),
    backupClusterDatabase: (ctx, id, input) => change(ctx, id, input, "backup"),
    removeClusterDatabase: (ctx, id, input) => change(ctx, id, input, "remove"),
    async connectClusterDatabase(ctx, id, input) {
      const result = await withLiveProjectRuntimeMutation(id, async () => {
        await project(ctx, id);
        const row = await repos.clusterDatabase.get(ctx.organizationId, id, input.databaseId);
        const value = input.envKey
          ? encrypt(clusterDatabaseUrl(row.id, row.config, decrypt(row.secretEncrypted)))
          : null;
        const updated = await repos.clusterDatabase.connect(
          ctx.organizationId,
          id,
          row.id,
          input.expectedSequence,
          input.envKey,
          value,
          input.replace,
        );
        notifyClusterDatabase(ctx.organizationId, id);
        audit(ctx, id, row.id, input.envKey ? "connected" : "disconnected");
        return presentClusterDatabase(updated);
      });
      if (!result) throw new AppError("The project is being removed.", 409, "PROJECT_UNAVAILABLE");
      return result;
    },
  };
}

/** Saved snapshots over SSE; periodic server-side reads also recover expired
 * leases. Reconnection never starts an installation or repeats a mutation. */
export async function* clusterDatabaseEvents(
  ctx: ExecutionContext,
  projectId: string,
  signal?: AbortSignal,
) {
  const load = async () => {
    signal?.throwIfAborted();
    await authorization.authorize(ctx, {
      resourceType: "project",
      resourceId: projectId,
      action: "read",
    });
    await project(ctx, projectId);
    return (await repos.clusterDatabase.list(ctx.organizationId, projectId)).map(
      presentClusterDatabase,
    );
  };
  await load();
  yield* durableRunEvents({
    signal,
    load,
    subscribe: (changed) =>
      clusterDatabaseBus.subscribe(clusterDatabaseTopic(ctx.organizationId, projectId), changed),
    version: (rows) =>
      createHash("sha256")
        .update(JSON.stringify(rows.map((row) => [row.id, row.sequence])))
        .digest("hex"),
    complete: () => false,
  });
}
