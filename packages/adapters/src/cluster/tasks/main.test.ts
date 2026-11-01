import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDatabaseTask, restoreSignature, taskError } from "./main";
import { TaskArchiveIndex, decodeArchiveEntries, encodeArchiveEntries } from "./archive-index";
import { TaskArchiveStore } from "./files";
import type { ArchiveEntry, DatabaseTaskConfig, RedisArchiveManifest } from "./types";

const engine = vi.hoisted(() => ({ capture: vi.fn(), restore: vi.fn() }));
vi.mock("./redis", async (original) => ({
  ...(await original<typeof import("./redis")>()),
  captureRedis: engine.capture,
  restoreRedis: engine.restore,
}));
const config: DatabaseTaskConfig = {
  operation: "redis-backup",
  namespace: `os-db-${"a".repeat(24)}`,
  databaseId: "database",
  runtimeId: "runtime",
  indexUid: "index",
  archiveName: "manual",
  destinationPath: "s3://saved-backups/archives",
  redis: { host: "database.private", port: 6379, mode: "standalone" },
  retentionDays: 7,
};
const prefix = `archives/${config.namespace}/redis`;
const manifest = (name: string): RedisArchiveManifest => ({
  format: "openship-redis-rdb-v1",
  databaseId: config.databaseId,
  runtimeId: config.runtimeId,
  mode: "standalone",
  createdAt: new Date().toISOString(),
  files: [
    {
      key: `${prefix}/${name}/attempt/standalone.rdb`,
      sizeBytes: 100,
      sha256: "a".repeat(64),
      primaryId: "standalone",
    },
  ],
});
let data: Record<string, string>, version: number, objects: Map<string, unknown>;
const entry = (name: string, pins: string[] = []): ArchiveEntry => ({
  name,
  phase: "completed",
  startedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  completedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  manifestKey: `${prefix}/${name}/manifest.json`,
  error: null,
  pins,
});
beforeEach(() => {
  vi.resetAllMocks();
  data = {};
  version = 1;
  objects = new Map();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Exercise the actual native catalogue CAS, including ownership and monotonic
  // completion. Only the transport to the disposable Kubernetes API is replaced.
  vi.spyOn(TaskArchiveIndex.prototype as any, "api").mockImplementation(
    async (...args: unknown[]) => {
      const [method, body] = args as [string, any];
      if (method === "PATCH") {
        if (body.metadata.resourceVersion !== String(version))
          throw Object.assign(new Error("Conflict"), { statusCode: 409 });
        data = { ...data, ...body.data };
        version++;
      }
      return {
        metadata: {
          uid: "index",
          resourceVersion: String(version),
          labels: { "openship.io/database": "database", "openship.io/runtime": "runtime" },
        },
        data: structuredClone(data),
      };
    },
  );
  vi.spyOn(TaskArchiveStore.prototype, "json").mockImplementation(
    async (key) => structuredClone(objects.get(key) ?? null) as any,
  );
  vi.spyOn(TaskArchiveStore.prototype, "commit").mockImplementation(async (key, value) => {
    objects.set(key, structuredClone(value));
  });
  vi.spyOn(TaskArchiveStore.prototype, "removeArchive").mockResolvedValue(undefined);
  engine.capture.mockResolvedValue(manifest("manual"));
  engine.restore.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("durable native database tasks", () => {
  it("recognizes completed recovery after persisted object keys are reordered", () => {
    const source = {
      databaseId: "source",
      runtimeId: "runtime",
      manifestKey: "archives/source/manifest.json",
    };
    const original = { ...config, operation: "redis-restore" as const, source };
    expect(restoreSignature(original)).toBe(
      restoreSignature({
        ...original,
        source: {
          manifestKey: source.manifestKey,
          runtimeId: source.runtimeId,
          databaseId: source.databaseId,
        },
        redis: { mode: "standalone", port: 6379, host: "database.private" },
      }),
    );
    expect(restoreSignature(original)).not.toBe(
      restoreSignature({
        ...original,
        source: { ...source, manifestKey: "archives/another/manifest.json" },
      }),
    );
  });
  it("never lets a late failed execution replace a completed and pinned recovery point", async () => {
    const completed = entry("completed", ["recovery"]);
    data.archives = encodeArchiveEntries([completed]);
    const index = new TaskArchiveIndex(config, AbortSignal.timeout(5000));
    await index.save({ ...completed, phase: "running", pins: [] });
    await index.save({ ...completed, phase: "failed", error: "late failure", pins: [] });
    expect(decodeArchiveEntries(data)).toEqual([completed]);
  });
  it("uses a committed manifest when another execution won its conditional write", async () => {
    vi.mocked(TaskArchiveStore.prototype.commit).mockImplementation(async (key) => {
      objects.set(key, manifest("manual"));
      throw Object.assign(new Error("Already committed"), { $metadata: { httpStatusCode: 412 } });
    });
    await runDatabaseTask(config, AbortSignal.timeout(5000));
    expect(decodeArchiveEntries(data)).toMatchObject([{ name: "manual", phase: "completed" }]);
    expect(engine.capture).toHaveBeenCalledOnce();
    await runDatabaseTask(config, AbortSignal.timeout(5000));
    expect(engine.capture).toHaveBeenCalledOnce();
  });
  it("protects pinned recovery points and retries interrupted retention cleanup", async () => {
    data.archives = encodeArchiveEntries([
      entry("pinned", ["target-database"]),
      { ...entry("old"), phase: "failed", error: "Archive retention cleanup in progress." },
    ]);
    await runDatabaseTask(config, AbortSignal.timeout(5000));
    expect(TaskArchiveStore.prototype.removeArchive).toHaveBeenCalledExactlyOnceWith(
      `${prefix}/old`,
    );
    expect(
      decodeArchiveEntries(data)
        .map((row) => row.name)
        .sort(),
    ).toEqual(["manual", "pinned"]);
  });
  it("does not repeat a restore after its native completion marker was saved", async () => {
    const recovery = {
      ...config,
      operation: "redis-restore" as const,
      source: {
        databaseId: config.databaseId,
        runtimeId: config.runtimeId,
        manifestKey: `${prefix}/source/manifest.json`,
      },
    };
    objects.set(recovery.source.manifestKey, manifest("source"));
    await runDatabaseTask(recovery, AbortSignal.timeout(5000));
    expect(data.restored).toBe(restoreSignature(recovery));
    await runDatabaseTask(recovery, AbortSignal.timeout(5000));
    expect(engine.restore).toHaveBeenCalledOnce();
  });
  it("stops a task when its saved catalogue was replaced", async () => {
    await expect(
      runDatabaseTask({ ...config, indexUid: "old-index" }, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/changed ownership/);
    expect(engine.capture).not.toHaveBeenCalled();
    expect(TaskArchiveStore.prototype.commit).not.toHaveBeenCalled();
  });
  it("redacts database and archive credentials from native failures", () => {
    vi.stubEnv("PGPASSWORD", "private-database-password");
    vi.stubEnv("BACKUP_SECRET_ACCESS_KEY", "private-storage-key");
    expect(
      taskError(
        new Error(
          "pg_restore private-database-password private-storage-key postgresql://user:pass@database.private",
        ),
      ),
    ).toBe("pg_restore [redacted] [redacted] postgresql://[redacted]@database.private");
  });
});
