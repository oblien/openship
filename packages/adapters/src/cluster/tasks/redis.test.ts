import { describe, expect, it } from "vitest";
import { redisPrimaries, redisReplicationIdentity, validateRedisManifest } from "./redis";
import { decodeArchiveEntries, encodeArchiveEntries } from "./archive-index";
import type { RedisArchiveManifest, ArchiveEntry } from "./types";

const topology = () =>
  [
    `${"1".repeat(40)} 10.0.0.1:6379@16379 master - 0 0 1 connected 0-5460`,
    `${"2".repeat(40)} 10.0.0.2:6379@16379 master - 0 0 2 connected 5461-10922`,
    `${"3".repeat(40)} 10.0.0.3:6379@16379 master - 0 0 3 connected 10923-16383`,
    ...[1, 2, 3].map(
      (id) =>
        `${String(id + 3).repeat(40)} 10.0.0.${id + 3}:6379@16379 slave ${String(id).repeat(40)} 0 0 ${id} connected`,
    ),
  ].join("\n");
describe("native Redis backup integrity", () => {
  it("checks non-sharded backup leadership without accepting a replica or degraded primary", () => {
    const healthy = `role:master\r\nconnected_slaves:2\r\nslave0:ip=10.0.0.2,port=6379,state=online,offset=10,lag=0\r\nslave1:ip=10.0.0.3,port=6379,state=online,offset=10,lag=0\r\nmaster_replid:${"a".repeat(40)}\r\n`;
    expect(redisReplicationIdentity(healthy)).toBe("a".repeat(40));
    expect(redisReplicationIdentity(healthy, 2)).toBe("a".repeat(40));
    expect(() => redisReplicationIdentity(healthy, 3)).toThrow(/verified primary/);
    expect(() =>
      redisReplicationIdentity(healthy.replace("state=online", "state=wait_bgsave"), 2),
    ).toThrow(/verified primary/);
    for (const invalid of [
      healthy.replace("role:master", "role:slave"),
      healthy.replace("connected_slaves:2", "connected_slaves:0"),
      healthy.replace("connected_slaves:2", "connected_slaves:unknown"),
      healthy.replace("connected_slaves:2", "missing-count:2"),
      healthy.replace("a".repeat(40), "unknown"),
      "",
    ])
      expect(() => redisReplicationIdentity(invalid)).toThrow(/verified primary/);
  });
  it("captures elected primaries using all assigned slots and healthy replicas", () => {
    const before = redisPrimaries(topology());
    expect(before.map((node) => node.host)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    expect(redisPrimaries(topology().split("\n").reverse().join("\n"))).toEqual(before);
  });
  it.each([
    ["in-flight reshard", (text: string) => text.replace("0-5460", "0-5460 [1->-node]")],
    ["missing replica", (text: string) => text.split("\n").slice(0, -1).join("\n")],
    ["failed member", (text: string) => text.replace("master -", "master,fail? -")],
    ["overlapping slots", (text: string) => text.replace("5461-10922", "5460-10922")],
    ["unassigned slots", (text: string) => text.replace("10923-16383", "10924-16383")],
  ])("refuses %s rather than committing an incomplete recovery point", (_name, change) => {
    expect(() => redisPrimaries(change(topology()))).toThrow();
  });
  it("rejects foreign, mixed and out-of-prefix recovery manifests", () => {
    const source = { databaseId: "db", runtimeId: "runtime" };
    const manifest: RedisArchiveManifest = {
      format: "openship-redis-rdb-v1",
      ...source,
      mode: "standalone",
      createdAt: new Date().toISOString(),
      files: [
        {
          primaryId: "standalone",
          key: "archives/db/backup/attempt/standalone.rdb",
          sizeBytes: 100,
          sha256: "1".repeat(64),
        },
      ],
    };
    expect(() => validateRedisManifest(manifest, source, "archives/db/backup")).not.toThrow();
    expect(() =>
      validateRedisManifest({ ...manifest, databaseId: "foreign" }, source, "archives/db/backup"),
    ).toThrow();
    expect(() =>
      validateRedisManifest(
        { ...manifest, files: [...manifest.files, ...manifest.files] },
        source,
        "archives/db/backup",
      ),
    ).toThrow();
    expect(() =>
      validateRedisManifest(
        {
          ...manifest,
          files: [{ ...manifest.files[0], key: "archives/db/backup/../elsewhere.rdb" }],
        },
        source,
        "archives/db/backup",
      ),
    ).toThrow();
  });
  it("keeps a year's hourly recovery catalogue and restore pins within a native ConfigMap", () => {
    const entries: ArchiveEntry[] = Array.from({ length: 8760 }, (_, i) => ({
      name: `archive-${i}`,
      phase: "completed",
      startedAt: new Date(i * 3600000).toISOString(),
      completedAt: new Date(i * 3600000 + 1000).toISOString(),
      error: null,
      manifestKey: `archives/cluster/database/${i}/manifest.json`,
      pins: i === 0 ? ["restore-one"] : [],
    }));
    const encoded = encodeArchiveEntries(entries);
    expect(encoded.length).toBeLessThan(750000);
    expect(decodeArchiveEntries({ archives: encoded })).toEqual(entries);
  });
});
