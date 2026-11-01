import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { importDatabaseBackup } from "./import";
import { uploadIncrementalArtifact } from "../../backup/common/incremental";
import type { BackupDestination } from "../../backup/types";
import type { TaskArchiveStore } from "./files";
import type { DatabaseTaskConfig } from "./types";

const loaders = vi.hoisted(() => ({ postgres: vi.fn(), redis: vi.fn() }));
vi.mock("./postgres", async (original) => ({
  ...(await original<typeof import("./postgres")>()),
  restorePostgres: loaders.postgres,
}));
vi.mock("./redis", async (original) => ({
  ...(await original<typeof import("./redis")>()),
  restoreRedis: loaders.redis,
}));

const bytes = Buffer.concat([Buffer.from("PGDMP"), Buffer.from([0, 255, 42, 13, 10])]);
const artifact = () => ({
  name: "pg-dump.dump",
  key: "project/database/run/pg-dump.dump",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  payloadKind: "pg_dump" as const,
  metadata: { compression: "none" },
});
const config = (): DatabaseTaskConfig => ({
  operation: "import-backup",
  databaseId: "new",
  runtimeId: "runtime",
  namespace: `os-db-${"a".repeat(24)}`,
  indexUid: "index",
  destinationPath: "s3://backups/archives",
  postgres: { host: "database.private", user: "app", database: "app" },
  artifact: artifact(),
});
let directory: string;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "openship-import-check-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("database import integrity before loading", () => {
  const store = (objects: Map<string, Buffer> = new Map([[artifact().key, bytes]])) =>
    ({
      signal: AbortSignal.timeout(5000),
      relativeGet: vi.fn(async (key: string) => {
        const value = objects.get(key);
        if (!value) throw new Error("The saved backup object is missing.");
        return Readable.from([value]);
      }),
    }) as unknown as TaskArchiveStore;

  it("hands the verified native bytes to the loader, including legacy codec metadata", async () => {
    loaders.postgres.mockImplementation(async (_config, path) => {
      expect(await readFile(path)).toEqual(bytes);
    });
    const input = config();
    input.artifact!.metadata = { compression: "zstd" };
    await importDatabaseBackup(input, store(), directory);
    expect(loaders.postgres).toHaveBeenCalledOnce();
    expect(loaders.redis).not.toHaveBeenCalled();
  });

  it.each(["checksum", "short", "oversize"])(
    "does not load data when the saved %s differs from the artifact",
    async (change) => {
      const input = config();
      if (change === "checksum") input.artifact!.sha256 = "0".repeat(64);
      else input.artifact!.sizeBytes += change === "short" ? 1 : -1;
      await expect(importDatabaseBackup(input, store(), directory)).rejects.toThrow(
        /integrity|recorded size/,
      );
      expect(loaders.postgres).not.toHaveBeenCalled();
      expect(loaders.redis).not.toHaveBeenCalled();
    },
  );

  it("reconstructs the existing backup format and refuses damaged reusable blocks", async () => {
    const objects = new Map<string, Buffer>();
    const destination = {
      async put(key: string, body: Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        const value = Buffer.concat(chunks);
        objects.set(key, value);
        return { bytesWritten: value.length };
      },
    } as unknown as BackupDestination;
    const saved = await uploadIncrementalArtifact(
      destination,
      { projectSlug: "project", serviceName: "database", runId: "run" },
      {
        name: artifact().name,
        payloadKind: "pg_dump",
        metadata: { compression: "none" },
        stream: Readable.from([bytes]),
      },
      [],
      [],
    );
    const input = { ...config(), artifact: { ...saved, payloadKind: "pg_dump" as const } };
    loaders.postgres.mockImplementation(async (_config, path) => {
      expect(await readFile(path)).toEqual(bytes);
    });
    await importDatabaseBackup(input, store(objects), directory);
    expect(loaders.postgres).toHaveBeenCalledOnce();
    loaders.postgres.mockClear();
    const block = [...objects.keys()].find((key) => key.endsWith(".gz"))!;
    objects.set(block, Buffer.from("damaged block"));
    await expect(importDatabaseBackup(input, store(objects), directory)).rejects.toThrow();
    expect(loaders.postgres).not.toHaveBeenCalled();
  });
});
