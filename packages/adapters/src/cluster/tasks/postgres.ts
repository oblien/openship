import { join } from "node:path";
import { databaseCommand } from "./command";
import type { TaskArchiveStore } from "./files";
import type { DatabaseTaskConfig, PostgresArchiveManifest } from "./types";

const environment = (endpoint: NonNullable<DatabaseTaskConfig["postgres"]>) => ({
  ...process.env,
  PGHOST: endpoint.host,
  PGPORT: "5432",
  PGDATABASE: endpoint.database,
  PGUSER: endpoint.user,
  PGSSLMODE: "require",
  PGCONNECT_TIMEOUT: "10",
});

export function validatePostgresManifest(
  manifest: PostgresArchiveManifest,
  source: { databaseId: string; runtimeId: string },
  prefix: string,
) {
  if (
    manifest?.format !== "openship-postgres-dump-v1" ||
    manifest.databaseId !== source.databaseId ||
    manifest.runtimeId !== source.runtimeId ||
    !/^[a-z][a-z0-9_]{0,47}$/.test(manifest.databaseName) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !manifest.file?.key.startsWith(`${prefix}/`) ||
    manifest.file.key.split("/").some((part) => !part || part === "." || part === "..") ||
    !Number.isSafeInteger(manifest.file.sizeBytes) ||
    manifest.file.sizeBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.file.sha256)
  )
    throw new Error("The PostgreSQL snapshot does not match this recovery request.");
}

export async function capturePostgres(
  config: DatabaseTaskConfig,
  store: TaskArchiveStore,
  directory: string,
  prefix: string,
) {
  if (!config.postgres) throw new Error("The saved PostgreSQL connection is missing.");
  const path = join(directory, "database.dump");
  console.info("Saving a consistent snapshot of the database for its new copy.");
  await databaseCommand(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl", "--file", path],
    store.signal,
    environment(config.postgres),
  );
  return {
    format: "openship-postgres-dump-v1",
    databaseId: config.databaseId,
    runtimeId: config.runtimeId,
    createdAt: new Date().toISOString(),
    databaseName: config.postgres.database,
    file: await store.upload(`${prefix}/database.dump`, path),
  } satisfies PostgresArchiveManifest;
}

export async function restorePostgres(
  config: DatabaseTaskConfig,
  path: string,
  signal: AbortSignal,
) {
  if (!config.postgres) throw new Error("The saved PostgreSQL connection is missing.");
  // Match the existing PostgreSQL backup loader: ownership belongs to the new
  // database's app user, with one transaction so a failed load cannot half-commit.
  await databaseCommand("pg_restore", ["--list", path], signal, environment(config.postgres));
  console.info("Loading the saved database into the new copy.");
  await databaseCommand(
    "pg_restore",
    [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
      "--single-transaction",
      "--exit-on-error",
      "--dbname",
      config.postgres.database,
      path,
    ],
    signal,
    environment(config.postgres),
  );
}
