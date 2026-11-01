import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { validateClusterDatabaseImportArtifact } from "@repo/core";
import { openBackupArtifact } from "../../backup/common/incremental";
import { databaseCommand } from "./command";
import { restorePostgres } from "./postgres";
import { restoreRedis } from "./redis";
import type { TaskArchiveStore } from "./files";
import type { DatabaseTaskConfig } from "./types";

/** Reuse the backup subsystem's block reconstruction and integrity contract. */
export async function importDatabaseBackup(
  config: DatabaseTaskConfig,
  store: TaskArchiveStore,
  directory: string,
) {
  validateClusterDatabaseImportArtifact(config.artifact);
  const artifact = config.artifact;
  const saved = join(directory, "saved-backup"),
    path = join(directory, "native-backup");
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    await openBackupArtifact({ get: (key) => store.relativeGet(key) }, artifact),
    new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > artifact.sizeBytes)
          return done(new Error("The imported backup exceeds its recorded size."));
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    createWriteStream(saved, { flags: "wx", mode: 0o600 }),
    { signal: store.signal },
  );
  if (bytes !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256)
    throw new Error("The backup integrity check failed. No data was loaded.");
  const handle = await open(saved, "r");
  const header = Buffer.alloc(5);
  try {
    await handle.read(header, 0, 5, 0);
  } finally {
    await handle.close();
  }
  // Older pg_dump producers recorded the preferred codec on already-compressed
  // custom dumps. Recognize the actual native header, as the existing loader does.
  if (header.toString() === "PGDMP" || header.toString() === "REDIS") await rename(saved, path);
  else {
    const codec = artifact.metadata?.compression ?? "none";
    if (codec !== "gzip" && codec !== "zstd")
      throw new Error("This backup does not contain a supported native database dump.");
    await rename(saved, `${path}.${codec === "gzip" ? "gz" : "zst"}`);
    await databaseCommand(
      codec === "gzip" ? "gzip" : "zstd",
      ["--decompress", `${path}.${codec === "gzip" ? "gz" : "zst"}`],
      store.signal,
    );
  }
  if (artifact.payloadKind === "pg_dump") {
    if (!config.postgres) throw new Error("Select a PostgreSQL target for this backup.");
    await restorePostgres(config, path, store.signal);
  } else {
    if (!config.redis) throw new Error("Select a Redis target for this backup.");
    await restoreRedis(
      config.redis,
      {
        format: "openship-redis-rdb-v1",
        databaseId: config.databaseId,
        runtimeId: config.runtimeId,
        mode: "standalone",
        createdAt: new Date().toISOString(),
        files: [{ ...artifact, primaryId: "standalone" }],
      },
      store,
      directory,
      console.info,
      path,
    );
  }
  await rm(path, { force: true });
}
