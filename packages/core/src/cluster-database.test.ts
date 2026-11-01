import { describe, expect, it } from "vitest";
import {
  clusterDatabasePodCount,
  validateClusterDatabase,
  validateClusterDatabaseUpdate,
  validateClusterDatabaseImportArtifact,
  type ClusterDatabaseConfig,
} from "./cluster-database";
const config: ClusterDatabaseConfig = {
  engine: "postgres",
  mode: "cluster",
  instances: 3,
  storageGiB: 20,
  storageClass: "openship-local",
  cpuMillis: 500,
  memoryMiB: 512,
  databaseName: "app",
};
describe("database lifecycle capabilities", () => {
  it("keeps existing PostgreSQL on its saved major and makes upgrades use a separate copy", () => {
    expect(() => validateClusterDatabase({ ...config, version: "18" })).not.toThrow();
    expect(() => validateClusterDatabaseUpdate(config, { ...config, version: "17" })).not.toThrow();
    expect(() => validateClusterDatabaseUpdate(config, { ...config, version: "18" })).toThrow(
      /upgraded copy/,
    );
    expect(() => validateClusterDatabase({ ...config, engine: "redis", version: "18" })).toThrow(
      /PostgreSQL/,
    );
  });
  it("admits only integrity-checked engine dumps and validates incremental block metadata", () => {
    const dump = {
      name: "database.dump",
      key: "project/database/dump",
      sizeBytes: 100,
      sha256: "a".repeat(64),
      payloadKind: "pg_dump",
      metadata: { compression: "none" },
    };
    expect(() => validateClusterDatabaseImportArtifact(dump)).not.toThrow();
    for (const patch of [
      { sha256: null },
      { key: "../other-project" },
      { payloadKind: "volume" },
      { metadata: { storage: { format: "chunks-v1" } } },
      { metadata: { encrypted: true } },
    ])
      expect(() => validateClusterDatabaseImportArtifact({ ...dump, ...patch })).toThrow();
  });
  it("distinguishes database instances from Redis shards and their replicas", () => {
    expect(clusterDatabasePodCount(config)).toBe(3);
    expect(clusterDatabasePodCount({ ...config, engine: "redis" })).toBe(6);
    expect(
      clusterDatabasePodCount({ ...config, engine: "redis", mode: "standalone", instances: 1 }),
    ).toBe(1);
  });
  it("distinguishes non-sharded Redis replication from sharding and refuses destructive conversion", () => {
    const replication: ClusterDatabaseConfig = { ...config, engine: "redis", mode: "replication" };
    expect(clusterDatabasePodCount(replication)).toBe(3);
    expect(() => validateClusterDatabase(replication)).not.toThrow();
    expect(() =>
      validateClusterDatabaseUpdate(replication, { ...replication, instances: 4 }),
    ).not.toThrow();
    expect(() =>
      validateClusterDatabaseUpdate({ ...replication, instances: 4 }, replication),
    ).toThrow(/cannot be removed in place/);
    expect(() => validateClusterDatabase({ ...replication, instances: 2 })).toThrow();
    expect(() => validateClusterDatabase({ ...replication, instances: 10 })).toThrow();
    expect(() => validateClusterDatabase({ ...replication, engine: "postgres" })).toThrow();
    expect(() =>
      validateClusterDatabaseUpdate(
        { ...replication, mode: "standalone", instances: 1 },
        replication,
      ),
    ).toThrow(/Create another database and restore/);
    expect(() =>
      validateClusterDatabaseUpdate(replication, { ...replication, mode: "cluster" }),
    ).toThrow(/Create another database and restore/);
  });
  it.each([
    { instances: 1 },
    { mode: "standalone", instances: 3 },
    { storageClass: "../outside" },
    { databaseName: "template0" },
    { cpuMillis: 0 },
    { memoryMiB: 128 },
  ])("refuses an unsupported database configuration %j", (patch) => {
    expect(() =>
      validateClusterDatabase({ ...config, ...patch } as ClusterDatabaseConfig),
    ).toThrow();
  });
  it("scales the same PostgreSQL resource between one primary and streaming replicas", () => {
    expect(() => validateClusterDatabaseUpdate(config, { ...config, instances: 4 })).not.toThrow();
    expect(() =>
      validateClusterDatabaseUpdate({ ...config, mode: "standalone", instances: 1 }, config),
    ).not.toThrow();
    expect(() =>
      validateClusterDatabaseUpdate(config, { ...config, mode: "standalone", instances: 1 }),
    ).not.toThrow();
    expect(() => validateClusterDatabase({ ...config, instances: 2 })).not.toThrow();
    expect(() => validateClusterDatabase({ ...config, engine: "redis", instances: 2 })).toThrow();
  });
  it("refuses shrinking, local volume expansion and accidental Redis resharding", () => {
    expect(() => validateClusterDatabaseUpdate(config, { ...config, storageGiB: 19 })).toThrow(
      "shrunk",
    );
    expect(() => validateClusterDatabaseUpdate(config, { ...config, storageGiB: 30 })).toThrow(
      "cannot be resized",
    );
    expect(() =>
      validateClusterDatabaseUpdate(
        { ...config, engine: "redis" },
        { ...config, engine: "redis", instances: 4 },
      ),
    ).toThrow("migration");
  });
  it("permits CSI expansion for PostgreSQL but refuses unverified Redis volume changes", () => {
    const postgres = { ...config, storageClass: "expandable-csi" };
    expect(() =>
      validateClusterDatabaseUpdate(postgres, { ...postgres, storageGiB: 30 }),
    ).not.toThrow();
    const redis = { ...postgres, engine: "redis" as const };
    expect(() => validateClusterDatabaseUpdate(redis, { ...redis, storageGiB: 30 })).toThrow(
      "Redis volume resizing is not supported",
    );
    expect(() => validateClusterDatabaseUpdate(redis, { ...redis, memoryMiB: 1024 })).not.toThrow();
  });
  it("preserves the archive destination while allowing schedule and retention changes", () => {
    const before = {
      ...config,
      backup: { destinationId: "archives", schedule: "daily" as const, retentionDays: 30 },
    };
    expect(() =>
      validateClusterDatabaseUpdate(before, {
        ...before,
        backup: { ...before.backup, schedule: "manual", retentionDays: 60 },
      }),
    ).not.toThrow();
    expect(() => validateClusterDatabaseUpdate(before, config)).toThrow("recovery history");
    expect(() =>
      validateClusterDatabaseUpdate(before, {
        ...before,
        backup: { ...before.backup, destinationId: "another" },
      }),
    ).toThrow("recovery history");
  });
  it("supports Redis archives while rejecting invalid retention periods", () => {
    const backup = { destinationId: "archives", schedule: "daily" as const, retentionDays: 30 };
    expect(() => validateClusterDatabase({ ...config, engine: "redis", backup })).not.toThrow();
    expect(() =>
      validateClusterDatabase({ ...config, backup: { ...backup, retentionDays: 0 } }),
    ).toThrow("between 7 and 365");
  });
  it("requires reviewed Redis redistribution and a saved backup destination", () => {
    const before = {
      ...config,
      engine: "redis" as const,
      backup: { destinationId: "archives", schedule: "daily" as const, retentionDays: 30 },
    };
    expect(() => validateClusterDatabaseUpdate(before, { ...before, instances: 4 })).toThrow(
      /Review and confirm/,
    );
    expect(() =>
      validateClusterDatabaseUpdate(
        before,
        { ...before, instances: 4 },
        { confirmRedisRebalance: true },
      ),
    ).not.toThrow();
    expect(() =>
      validateClusterDatabaseUpdate(
        { ...before, backup: undefined },
        { ...before, instances: 4 },
        { confirmRedisRebalance: true },
      ),
    ).toThrow(/Save a backup destination/);
  });
});
