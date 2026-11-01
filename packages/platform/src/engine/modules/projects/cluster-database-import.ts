import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  AppError,
  validateClusterDatabaseImportArtifact,
  type ClusterDatabaseRestoreSource,
} from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { assertResourceInOrg } from "../../lib/resource-access";
import { resolveClusterBackupStorage } from "../../lib/cluster-backup-storage";

export async function authorizeDatabaseImport(ctx: ExecutionContext, projectId: string) {
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "project", resourceId: projectId, action: "admin" },
  );
}

/** The caller holds the source backup lock until the new database is saved. */
export async function databaseImportSource(
  ctx: ExecutionContext,
  projectId: string,
  input: { runId: string; artifactName: string },
  engine: "postgres" | "redis",
): Promise<ClusterDatabaseRestoreSource> {
  await authorizeDatabaseImport(ctx, projectId);
  const run = await repos.backupRun.findById(input.runId);
  assertResourceInOrg(run, "Backup", ctx.organizationId, input.runId);
  if (
    !run.projectId ||
    run.projectId !== projectId ||
    run.sourceKind !== "service" ||
    run.status !== "succeeded" ||
    run.deletedAt ||
    !run.destinationId ||
    (run.executionStartedAt && !run.executionFinishedAt)
  )
    throw new AppError(
      "Choose a completed database backup from this project.",
      422,
      "CLUSTER_DATABASE_IMPORT_SOURCE",
    );
  const matches = (run.artifacts ?? []).filter(
    (value) => (value as { name?: string })?.name === input.artifactName,
  );
  if (matches.length !== 1)
    throw new AppError(
      "The selected database backup could not be identified.",
      422,
      "CLUSTER_DATABASE_IMPORT_SOURCE",
    );
  const artifact = matches[0];
  validateClusterDatabaseImportArtifact(artifact);
  if ((engine === "postgres" ? "pg_dump" : "redis_rdb") !== artifact.payloadKind)
    throw new AppError(
      "Select the same database type as the backup.",
      422,
      "CLUSTER_DATABASE_IMPORT_SOURCE",
    );
  const destination = await repos.backupDestination.findById(run.destinationId);
  assertResourceInOrg(destination, "Backup destination", ctx.organizationId, run.destinationId);
  const prefix = (destination.pathPrefix ?? "").replace(/^\/+|\/+$/g, "");
  const source: ClusterDatabaseRestoreSource = {
    format: "backup-artifact",
    backupRunId: run.id,
    artifact,
    databaseId: `backup:${run.id}`,
    backupId: artifact.key,
    backupName: artifact.name,
    destinationId: destination.id,
    destinationPath: `s3://${destination.bucket}/${prefix ? `${prefix}/` : ""}`,
    serverName: "",
    endpoint: destination.endpoint,
  };
  await resolveClusterBackupStorage(ctx, source.destinationId, source);
  return source;
}

export async function listDatabaseImports(ctx: ExecutionContext, projectId: string) {
  await authorizeDatabaseImport(ctx, projectId);
  const runs = await repos.backupRun.listWithSources(ctx.organizationId, { projectId, limit: 100 });
  const destinations = new Map<string, boolean>();
  const options: Array<{
    runId: string;
    artifactName: string;
    engine: "postgres" | "redis";
    sourceName: string;
    completedAt: string | null;
    sizeBytes: number;
  }> = [];
  for (const run of runs) {
    if (
      run.status !== "succeeded" ||
      !run.destinationId ||
      run.sourceKind !== "service" ||
      (run.executionStartedAt && !run.executionFinishedAt)
    )
      continue;
    if (!destinations.has(run.destinationId)) {
      const destination = await repos.backupDestination.findById(run.destinationId);
      destinations.set(
        run.destinationId,
        destination?.organizationId === ctx.organizationId && destination.kind === "s3_compatible",
      );
    }
    if (!destinations.get(run.destinationId)) continue;
    for (const artifact of run.artifacts ?? []) {
      try {
        validateClusterDatabaseImportArtifact(artifact);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/projects/cluster-database-import");
        continue;
      }
      options.push({
        runId: run.id,
        artifactName: artifact.name,
        engine: artifact.payloadKind === "pg_dump" ? "postgres" : "redis",
        sourceName: run.serviceName ?? run.projectName ?? "Database",
        completedAt: run.finishedAt?.toISOString() ?? null,
        sizeBytes: artifact.sizeBytes,
      });
    }
  }
  return options;
}
