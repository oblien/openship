import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TaskArchiveStore } from "./files";
import { TaskArchiveIndex, decodeArchiveEntries, encodeArchiveEntries } from "./archive-index";
import { captureRedis, restoreRedis, validateRedisManifest } from "./redis";
import { capturePostgres, restorePostgres, validatePostgresManifest } from "./postgres";
import { importDatabaseBackup } from "./import";
import type {
  ArchiveEntry,
  DatabaseTaskConfig,
  RedisArchiveManifest,
  PostgresArchiveManifest,
} from "./types";

export const restoreSignature = (config: DatabaseTaskConfig) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        {
          databaseId: config.databaseId,
          runtimeId: config.runtimeId,
          redis: config.redis,
          postgres: config.postgres,
          source: config.source,
          artifact: config.artifact,
        },
        (_key, value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).sort(([left], [right]) =>
                  left < right ? -1 : left > right ? 1 : 0,
                ),
              )
            : value,
      ),
    )
    .digest("hex");
export function taskError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [
    "REDISCLI_AUTH",
    "PGPASSWORD",
    "BACKUP_ACCESS_KEY_ID",
    "BACKUP_SECRET_ACCESS_KEY",
  ]) {
    const secret = process.env[key];
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message
    .replace(/((?:https?|postgres(?:ql)?|redis):\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .slice(-3000);
}
const cleanupMessage = "Archive retention cleanup in progress.";
async function prune(config: DatabaseTaskConfig, index: TaskArchiveIndex, store: TaskArchiveStore) {
  if (!config.retentionDays) return;
  const cutoff = Date.now() - config.retentionDays * 86400000;
  for (const entry of await index.entries()) {
    if (
      Date.parse(entry.completedAt ?? entry.startedAt) >= cutoff ||
      entry.pins?.length ||
      !entry.manifestKey
    )
      continue;
    const engine = config.postgres ? "postgres" : "redis";
    const prefix = `${store.prefix}/${config.namespace}/${engine}/${entry.name}`;
    if (!/^[a-z0-9-]{1,100}$/.test(entry.name) || entry.manifestKey !== `${prefix}/manifest.json`)
      throw new Error("The backup catalogue contains an unexpected archive location.");
    // Retention and restore pinning claim the same native resourceVersion.
    let claimed = false;
    await index.update((data) => {
      claimed = false;
      const entries = decodeArchiveEntries(data);
      const current = entries.find((item) => item.name === entry.name);
      if (
        current &&
        !current.pins?.length &&
        Date.parse(current.completedAt ?? current.startedAt) < cutoff
      ) {
        current.phase = "failed";
        current.error = cleanupMessage;
        claimed = true;
      }
      return { ...data, archives: encodeArchiveEntries(entries) };
    });
    if (!claimed) continue;
    // Also removes abandoned immutable attempts from a failed/lost native Job.
    // The deletion marker survives partial S3 failures for the next sweep.
    await store.removeArchive(prefix);
    await index.update((data) => ({
      ...data,
      archives: encodeArchiveEntries(
        decodeArchiveEntries(data).filter((item) => item.name !== entry.name),
      ),
    }));
  }
}

export async function runDatabaseTask(config: DatabaseTaskConfig, signal: AbortSignal) {
  if (
    ![
      "redis-backup",
      "redis-restore",
      "postgres-backup",
      "postgres-restore",
      "import-backup",
    ].includes(config.operation) ||
    !/^os-db-[a-f0-9]{24}$/.test(config.namespace) ||
    !config.databaseId ||
    !config.runtimeId ||
    !config.indexUid
  )
    throw new Error("The database task has an invalid saved configuration.");
  const index = new TaskArchiveIndex(config, signal);
  const store = new TaskArchiveStore(config.destinationPath, signal);
  const directory = await mkdtemp(join(tmpdir(), "openship-data-"));
  try {
    await index.read();
    if (config.operation.endsWith("restore") || config.operation === "import-backup") {
      const signature = restoreSignature(config);
      if ((await index.read()).data?.restored === signature) {
        console.info("This recovery request already completed. Keeping the recovered data.");
        return;
      }
      if (config.operation === "import-backup")
        await importDatabaseBackup(config, store, directory);
      else {
        if (!config.source) throw new Error("This recovery task has no saved source.");
        const manifest = await store.json<RedisArchiveManifest | PostgresArchiveManifest>(
          config.source.manifestKey,
        );
        if (!manifest) throw new Error("The saved database archive is missing.");
        const prefix = config.source.manifestKey.slice(
          0,
          config.source.manifestKey.lastIndexOf("/"),
        );
        if (config.operation === "redis-restore") {
          if (!config.redis) throw new Error("The saved Redis connection is missing.");
          validateRedisManifest(manifest as RedisArchiveManifest, config.source, prefix);
          await restoreRedis(
            config.redis,
            manifest as RedisArchiveManifest,
            store,
            directory,
            console.info,
          );
        } else {
          validatePostgresManifest(manifest as PostgresArchiveManifest, config.source, prefix);
          const path = join(directory, "database.dump");
          await store.download((manifest as PostgresArchiveManifest).file, path);
          await restorePostgres(config, path, signal);
        }
      }
      await index.update((data) => ({ ...data, restored: signature }));
      console.info("The saved data was recovered into the new database.");
      return;
    }
    const name = config.archiveName ?? process.env.JOB_NAME;
    if (!name || !/^[a-z0-9-]{1,100}$/.test(name))
      throw new Error("The backup task has no valid request identity.");
    const prefix = `${store.prefix}/${config.namespace}/${config.postgres ? "postgres" : "redis"}/${name}`;
    const manifestKey = `${prefix}/manifest.json`;
    const previous = (await index.entries()).find((row) => row.name === name);
    if (previous?.phase === "completed") return;
    let entry: ArchiveEntry = {
      name,
      phase: "running",
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      completedAt: null,
      error: null,
      manifestKey,
    };
    await index.save(entry);
    try {
      let manifest = await store.json<RedisArchiveManifest | PostgresArchiveManifest>(manifestKey);
      if (!manifest) {
        const attempt = `${prefix}/${randomUUID()}`;
        if (config.operation === "postgres-backup")
          manifest = await capturePostgres(config, store, directory, attempt);
        else {
          if (!config.redis) throw new Error("The saved Redis connection is missing.");
          manifest = await captureRedis(
            config.redis,
            store,
            directory,
            attempt,
            config,
            console.info,
          );
        }
        try {
          await store.commit(manifestKey, manifest);
        } catch (error) {
          if (
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412
          )
            throw error;
          manifest = await store.json<RedisArchiveManifest | PostgresArchiveManifest>(manifestKey);
          if (!manifest) throw error;
        }
      }
      if (config.operation === "postgres-backup")
        validatePostgresManifest(manifest as PostgresArchiveManifest, config, prefix);
      else validateRedisManifest(manifest as RedisArchiveManifest, config, prefix);
      entry = { ...entry, phase: "completed", completedAt: manifest.createdAt };
      await index.save(entry);
      console.info(
        "The database snapshot and its integrity manifest are saved in the backup destination.",
      );
    } catch (error) {
      await index.save({ ...entry, phase: "failed", error: taskError(error) }).catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/cluster/tasks/main");
      });
      throw error;
    }
    try {
      await prune(config, index, store);
    } catch (error) {
      errorDiagnostics.error("adapters/cluster/tasks/main", `Backup saved; older archive cleanup needs attention: ${taskError(error)}`, error);
    }
  } finally {
    store.client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}
