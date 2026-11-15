import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { resolvePinnedHost } from "@repo/adapters/outbound-target";
import {
  resolveExecutor,
  resolveProducer,
  transferVolume,
  ensureCloudProjectVolume,
  HashingPassthrough,
  type BackupExecutor,
  type ServiceHandle,
  type ExecExitInfo,
} from "@repo/adapters";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PlannedImportService } from "./platform-import-plan";
import type { ProviderService } from "./providers/types";
import { openRailwayDataSource } from "./providers/railway-data";
import { assertRailwayExportOnly } from "./providers/railway-project-transfer";
import { createMigrationDockerRuntime } from "./migration-runtime";
import { requireMigrationServer } from "./migration-access";
import { withCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { containerIdForService } from "../services/service-container";
import { serviceHandleFor } from "../backups/service-handle";

function providerHandle(source: ProviderService): ServiceHandle {
  return {
    id: source.id,
    name: source.name,
    projectId: source.id,
    projectSlug: source.id,
    containerId: source.instanceId ?? null,
    image: source.image ?? null,
    env: source.env,
    volumes: source.volumes.map((v) => v.mountPath),
    namespaceVolumes: false,
  };
}

/** Validate the transfer strategy and external database address before project
 * allocation. Railway storage is read only after its writers have stopped. */
export async function preflightPlatformData(services: PlannedImportService[], signal: AbortSignal) {
  for (const service of services) {
    signal.throwIfAborted();
    if (service.data !== "copy" || (!service.source.database && !service.source.volumes.length))
      continue;
    // Cold exports run our own portable tar container after the entire project
    // has stopped. They never depend on a source engine or installed DB tools.
    if (service.transfer === "cold-volume") continue;
    if (service.source.externalDatabase) {
      await postgresImportConnection(service.source.externalDatabase, signal);
      continue;
    }
    throw new AppError(
      "Review this import again to select its storage transfer method.",
      409,
      "IMPORT_TRANSFER_PLAN_INVALID",
    );
  }
}

async function readProbe(result: { stdout: Readable; awaitExit: Promise<ExecExitInfo> }) {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of result.stdout) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024)
        throw new AppError(
          "The database compatibility response was too large",
          502,
          "IMPORT_DATABASE_PROBE_FAILED",
        );
      chunks.push(buffer);
    }
    if ((await result.awaitExit).code !== 0)
      throw new AppError(
        "The source database could not be read. Check its direct connection, TLS settings and export permissions.",
        502,
        "IMPORT_DATABASE_PROBE_FAILED",
      );
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    result.stdout.destroy();
    await result.awaitExit;
  }
}

export async function postgresImportConnection(
  raw: string,
  signal: AbortSignal,
): Promise<NonNullable<ServiceHandle["postgresConnection"]>> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      "Enter a valid PostgreSQL connection URL",
      400,
      "IMPORT_DATABASE_URL_INVALID",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username ||
    !url.hostname ||
    url.hash
  )
    throw new AppError(
      "Use a direct PostgreSQL connection with a username",
      400,
      "IMPORT_DATABASE_URL_INVALID",
    );
  const sslMode = url.searchParams.get("sslmode") ?? "require";
  const channelBinding = url.searchParams.get("channel_binding");
  if (
    !["require", "verify-ca", "verify-full"].includes(sslMode) ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode" && key !== "channel_binding")
  )
    throw new AppError(
      "Use a direct PostgreSQL URL with sslmode=require, verify-ca or verify-full. Pooler and custom client options need a separate export.",
      400,
      "IMPORT_DATABASE_URL_INVALID",
    );
  if (channelBinding && !["disable", "prefer", "require"].includes(channelBinding))
    throw new AppError(
      "The PostgreSQL channel binding option is invalid",
      400,
      "IMPORT_DATABASE_URL_INVALID",
    );
  const port = Number(url.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AppError("Invalid database port", 400, "IMPORT_DATABASE_URL_INVALID");
  const pinned = await resolvePinnedHost(url.hostname, false, signal);
  return {
    host: url.hostname,
    hostAddress: pinned.ip,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
    sslMode: sslMode as "require" | "verify-ca" | "verify-full",
    ...(channelBinding
      ? { channelBinding: channelBinding as "disable" | "prefer" | "require" }
      : {}),
  };
}

export async function verifyImportPostgres(
  source: ServiceHandle,
  target: ServiceHandle,
  sourceExecutor: BackupExecutor,
  targetExecutor: BackupExecutor,
  signal: AbortSignal,
) {
  const probe = async (handle: ServiceHandle, executor: BackupExecutor, sql: string) => {
    const connection = handle.postgresConnection;
    const user = connection?.user ?? handle.env.POSTGRES_USER ?? "postgres";
    return readProbe(
      await executor.execStream(
        handle,
        [
          "psql",
          "-XAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          user,
          "-d",
          connection?.database ?? handle.env.POSTGRES_DB ?? user,
          "-c",
          sql,
        ],
        {
          signal,
          timeoutMs: 30_000,
          env: {
            PGPASSWORD:
              connection?.password ?? handle.env.POSTGRES_PASSWORD ?? handle.env.PGPASSWORD ?? "",
            ...(connection
              ? {
                  PGHOST: connection.host,
                  PGHOSTADDR: connection.hostAddress,
                  PGPORT: String(connection.port),
                  PGSSLMODE: connection.sslMode,
                  ...(connection.channelBinding
                    ? { PGCHANNELBINDING: connection.channelBinding }
                    : {}),
                }
              : {}),
          },
        },
      ),
    );
  };
  const [version, targetVersion] = await Promise.all([
    probe(source, sourceExecutor, "SHOW server_version_num"),
    probe(target, targetExecutor, "SHOW server_version_num"),
  ]);
  if (
    !/^\d{5,6}$/.test(version) ||
    !/^\d{5,6}$/.test(targetVersion) ||
    Math.floor(Number(version) / 10000) !== Math.floor(Number(targetVersion) / 10000)
  )
    throw new AppError(
      "The source and target PostgreSQL major versions differ. Review the source version before copying.",
      409,
      "IMPORT_DATABASE_VERSION_MISMATCH",
    );
  const [extensions, available] = await Promise.all([
    probe(source, sourceExecutor, "SELECT extname FROM pg_extension"),
    probe(target, targetExecutor, "SELECT name FROM pg_available_extensions"),
  ]);
  const offered = new Set(available.split("\n"));
  if (extensions.split("\n").some((name) => !offered.has(name)))
    throw new AppError(
      "This source requires PostgreSQL extensions missing from the selected image. Choose a compatible image or retain the external database.",
      409,
      "IMPORT_DATABASE_EXTENSIONS_MISSING",
    );
}

/** Data uses the same database producers and volume transfer adapters as
 * backups/server migration. No local Docker or host-shell fallback is allowed. */
export async function copyPlatformData(input: {
  runId: string;
  service: PlannedImportService;
  projectId: string;
  serviceId: string;
  deploymentId?: string;
  signal: AbortSignal;
  log: (text: string) => void;
  progress: (bytes: number) => void;
}) {
  const { service, signal } = input;
  if (service.data !== "copy" || (!service.source.database && !service.source.volumes.length))
    return;
  const project = await repos.project.findById(input.projectId);
  if (!project?.serverId)
    throw new AppError("The import destination is unavailable", 409, "IMPORT_TARGET_MISSING");
  const server = await requireMigrationServer(project.organizationId, project.serverId, "target");
  const work = async () => {
    const runtime = await createMigrationDockerRuntime(project.serverId!, project.organizationId);
    let sourceConnection: Awaited<ReturnType<typeof openRailwayDataSource>> | undefined;
    try {
      const targetExecutor = resolveExecutor(runtime.name, runtime);
      const row = (await repos.service.listByProject(project.id)).find(
        (service) => service.id === input.serviceId,
      );
      if (!row)
        throw new AppError(
          "The destination service no longer matches this import. Review its storage before retrying.",
          409,
          "IMPORT_TARGET_SERVICE_MISSING",
        );
      const deployment = input.deploymentId
        ? await repos.deployment.findById(input.deploymentId)
        : undefined;
      const target = await serviceHandleFor(row, {
        projectSlug: project.slug,
        containerId: deployment ? await containerIdForService(deployment, row) : null,
      });
      const source = providerHandle(service.source);
      let sourceExecutor: BackupExecutor;
      if (service.source.externalDatabase) {
        source.containerId = target.containerId;
        source.postgresConnection = await postgresImportConnection(
          service.source.externalDatabase,
          signal,
        );
        sourceExecutor = targetExecutor;
      } else {
        if (service.transfer !== "cold-volume")
          throw new AppError(
            "Review this import again to select its storage transfer method.",
            409,
            "IMPORT_TRANSFER_PLAN_INVALID",
          );
        sourceConnection = await openRailwayDataSource(input.runId, service.source, signal);
        sourceExecutor = sourceConnection.executor;
      }
      if (service.source.externalDatabase) {
        if (!target.containerId)
          throw new AppError(
            "The destination database is not running",
            409,
            "IMPORT_DATABASE_NOT_READY",
          );
        const producer = resolveProducer("pg_dump");
        await producer.waitUntilReady?.(target, targetExecutor, signal);
        await verifyImportPostgres(source, target, sourceExecutor, targetExecutor, signal);
        let artifacts = 0;
        for await (const artifact of producer.produce(source, sourceExecutor, {})) {
          signal.throwIfAborted();
          artifacts++;
          const meter = new HashingPassthrough({ onBytes: input.progress });
          let copied: Promise<void> | undefined;
          try {
            await producer.restore(
              target,
              targetExecutor,
              {
                key: artifact.name,
                metadata: artifact.metadata,
                payloadKind: artifact.payloadKind,
                sha256: "",
                sizeBytes: 0,
                open: async () => {
                  if (copied) throw new Error("The import stream was already consumed");
                  copied = pipeline(artifact.stream, meter, { signal });
                  void copied.catch(() => {
                    /* diagnostics-ignore: awaited below; observe early rejection while restore consumes the stream. */
                  });
                  return meter;
                },
              },
              { signal },
            );
            if (!copied) throw new Error("Restore did not consume the database export");
            await copied;
          } finally {
            meter.destroy();
            artifact.stream.destroy();
            await copied?.catch(() => {
              /* diagnostics-ignore: preserve the original restore failure while settling the pipeline. */
            });
          }
        }
        if (!artifacts)
          throw new AppError(
            "The source returned no database backup",
            502,
            "IMPORT_DATABASE_EMPTY_EXPORT",
          );
      } else {
        if (service.transfer === "cold-volume") await assertRailwayExportOnly(input.runId);
        for (let index = 0; index < service.source.volumes.length; index++) {
          signal.throwIfAborted();
          const volume = service.source.volumes[index];
          const targetSources = await targetExecutor.listSources(target);
          const destination = targetSources.find((s) => s.target === volume.mountPath);
          if (!destination || destination.type !== "volume")
            throw new AppError(
              "The destination volume does not match the reviewed mount",
              409,
              "IMPORT_VOLUME_MISMATCH",
            );
          const before = await targetExecutor.probeVolume?.(target, destination.id);
          if (!before || (before.exists && !before.empty))
            throw new AppError(
              "The destination volume is not empty. Existing data was retained.",
              409,
              "IMPORT_VOLUME_NOT_EMPTY",
            );
          // The executor resolves the same storage identity as deployment:
          // immutable project names on Cloud and scoped names on SSH servers.
          const name = destination.source;
          await runtime.docker.createVolume({
            Name: name,
            Labels: { "openship.project": project.id, "openship.migration": input.runId },
          });
          const owned = await runtime.docker.getVolume(name).inspect();
          if (
            owned.Labels?.["openship.project"] !== project.id ||
            owned.Labels?.["openship.migration"] !== input.runId
          )
            throw new AppError(
              "The destination volume belongs to another operation",
              409,
              "IMPORT_VOLUME_OWNERSHIP",
            );
          if (server.workspaceId) await ensureCloudProjectVolume(runtime.docker, name, project.id);
          input.log(`Copying ${volume.mountPath} for ${service.create.name}`);
          await transferVolume(
            { exec: sourceExecutor, handle: source, sourceId: volume.mountPath },
            { exec: targetExecutor, handle: target, sourceId: destination.id },
            {
              mode: "stream",
              compression: "gzip",
              signal,
              onProgress: input.progress,
            },
          );
        }
        if (service.transfer === "cold-volume") await assertRailwayExportOnly(input.runId);
      }
    } finally {
      try {
        await sourceConnection?.dispose();
      } finally {
        await runtime.dispose();
      }
    }
  };
  const guarded = () =>
    withProjectRuntimeLock(
      project.id,
      async () => {
        const current = await repos.project.findById(project.id);
        if (
          !current ||
          current.deletionInProgress ||
          current.serverId !== project.serverId ||
          (current.activeDeploymentId ?? undefined) !== input.deploymentId
        )
          throw new AppError(
            "The destination changed during import. Its current deployment and data were left untouched.",
            409,
            "IMPORT_TARGET_CHANGED",
          );
        await work();
      },
      signal,
    );
  if (server.workspaceId)
    await withCloudWorkspaceActivity(server.workspaceId, guarded, signal, {
      scope: `migration:${input.runId}`,
    });
  else await guarded();
}
