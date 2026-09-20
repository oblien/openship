import { describe, expect, it } from "vitest";
import {
  DATABASE_CATALOG,
  REGIONS,
  SCALE_CATALOG,
  addClusterMember,
  availableClusterAdditions,
  clusterReplicationModes,
  configureCluster,
  createResource,
  getClusterTopology,
  isClusterResource,
  isClusterTopology,
  isDatabaseResource,
  parseDraft,
  setReplicationMode,
  setReplicationSource,
  type ClusterResource,
  type DatabaseKind,
  type DatabaseMode,
  type DatabaseResource,
} from "./index";

function database(kind: DatabaseKind, mode: DatabaseMode = "standalone"): DatabaseResource {
  const resource = createResource(kind, kind, 1, mode);
  if (!isDatabaseResource(resource)) throw new Error("Expected a database");
  return resource;
}

function cluster(kind: DatabaseKind): ClusterResource {
  const resource = database(kind, "cluster");
  if (!isClusterResource(resource)) throw new Error("Expected a cluster");
  return resource;
}

const restore = (resource: unknown) =>
  parseDraft(JSON.stringify({ version: 2, services: [], nodes: [resource], edges: [] }));

describe("shared Scale capabilities and commands", () => {
  it("publishes a serializable planning catalog independently of the app installation catalog", () => {
    const catalog = JSON.parse(JSON.stringify(SCALE_CATALOG));
    expect(catalog.version).toBe(1);
    expect(catalog.stage).toBe("planning");
    expect(catalog.resourceKinds).toEqual(["edge", "service", "postgres", "redis"]);
    expect(catalog.resources.postgres.deployments.cluster.topology).toBe("primary-replicas");
    expect(catalog.resources.redis.deployments.cluster.topology).toBe("sharded");
    expect(catalog.resources.redis.deployments.cluster.sharding.uniformReplicas).toBe(true);
  });

  it.each(["postgres", "redis"] as const)("rejects member commands on standalone %s", (kind) => {
    const resource = database(kind);
    const before = JSON.stringify(resource);
    expect(availableClusterAdditions(resource)).toEqual([]);
    for (const action of ["add-replica", "add-shard", "add-replica-per-shard"] as const)
      expect(() => addClusterMember(resource, action)).toThrow("does not support");
    expect(JSON.stringify(resource)).toBe(before);
    expect(restore(resource)?.nodes[0]).toEqual(resource);
  });

  it("adds a PostgreSQL reader while retaining the primary and existing member configuration", () => {
    const original = cluster("postgres");
    const topology = getClusterTopology(original);
    const configured = {
      ...original,
      topology: {
        nodes: topology.nodes.map((node) =>
          node.role === "primary"
            ? { ...node, name: "Orders primary", position: { x: -120, y: 160 } }
            : node.id === "replica-1-1"
              ? { ...node, name: "Reporting", region: REGIONS[2].id, position: { x: 720, y: 540 } }
              : node,
        ),
        edges: topology.edges.filter((edge) => edge.target !== "replica-1-1"),
      },
    };
    const before = JSON.stringify(configured);
    expect(availableClusterAdditions(configured).map((action) => action.id)).toEqual([
      "add-replica",
    ]);
    const next = addClusterMember(configured, "add-replica");
    const members = getClusterTopology(next);
    expect(members.nodes.filter((node) => node.role === "primary")).toEqual([
      configured.topology.nodes[0],
    ]);
    expect(members.nodes.find((node) => node.id === "replica-1-1")).toEqual(
      configured.topology.nodes[1],
    );
    expect(members.edges.some((edge) => edge.target === "replica-1-1")).toBe(false);
    expect(members.edges.find((edge) => edge.target === "replica-1-3")).toMatchObject({
      source: "primary-1",
      mode: "async",
    });
    expect(members.nodes).toHaveLength(4);
    expect(restore(next)?.nodes[0]).toEqual(next);
    expect(JSON.stringify(configured)).toBe(before);
  });

  it("adds a Redis shard with its configured replicas, and explicitly adds replicas across all shards", () => {
    const original = cluster("redis");
    const withShard = addClusterMember(original, "add-shard");
    const shardTopology = getClusterTopology(withShard);
    expect(withShard).toMatchObject({ shards: 4, replicasPerShard: 1 });
    expect(shardTopology.nodes).toHaveLength(8);
    expect(shardTopology.edges.find((edge) => edge.target === "replica-4-1")).toMatchObject({
      source: "primary-4",
    });
    const next = addClusterMember(withShard, "add-replica-per-shard");
    const topology = getClusterTopology(next);
    expect(next).toMatchObject({ shards: 4, replicasPerShard: 2 });
    expect(topology.nodes).toHaveLength(12);
    for (const primary of topology.nodes.filter((node) => node.role === "primary")) {
      const replicas = topology.nodes.filter(
        (node) => node.role === "replica" && node.shard === primary.shard,
      );
      expect(replicas).toHaveLength(2);
      for (const replica of replicas)
        expect(topology.edges.find((edge) => edge.target === replica.id)?.source).toBe(primary.id);
    }
    expect(restore(next)?.nodes[0]).toEqual(next);
    expect(original).toMatchObject({ shards: 3, replicasPerShard: 1 });
  });

  it("rejects unsupported actions without silently performing another database action", () => {
    const postgres = cluster("postgres");
    const redis = cluster("redis");
    expect(() => addClusterMember(postgres, "add-shard")).toThrow("does not support");
    expect(() => addClusterMember(postgres, "add-replica-per-shard")).toThrow("does not support");
    expect(() => addClusterMember(redis, "add-replica")).toThrow("does not support");
  });

  it("enforces PostgreSQL capacity in commands and serialized validation", () => {
    const original = cluster("postgres");
    if (original.kind !== "postgres") throw new Error("Expected PostgreSQL");
    const full = configureCluster({ ...original, replicas: 8 });
    expect(availableClusterAdditions(full)[0]).toMatchObject({
      disabled: true,
      disabledReason: "Limit reached: 8 read replicas.",
    });
    expect(() => addClusterMember(full, "add-replica")).toThrow("Limit reached");
    expect(restore(full)).not.toBeNull();
    expect(restore({ ...full, replicas: 9, topology: undefined })).toBeNull();
  });

  it("disables Redis actions independently when each capacity is reached", () => {
    const original = cluster("redis");
    if (original.kind !== "redis") throw new Error("Expected Redis");
    const replicasFull = configureCluster({ ...original, replicasPerShard: 2 });
    if (replicasFull.kind !== "redis") throw new Error("Expected Redis");
    expect(
      availableClusterAdditions(replicasFull).map(({ id, disabled }) => ({ id, disabled })),
    ).toEqual([
      { id: "add-shard", disabled: false },
      { id: "add-replica-per-shard", disabled: true },
    ]);
    expect(() => addClusterMember(replicasFull, "add-replica-per-shard")).toThrow("Limit reached");
    const full = configureCluster({ ...replicasFull, shards: 12 });
    expect(availableClusterAdditions(full).every((action) => action.disabled)).toBe(true);
    expect(() => addClusterMember(full, "add-shard")).toThrow("Limit reached");
    expect(restore({ ...full, shards: 13, topology: undefined })).toBeNull();
    expect(restore({ ...full, replicasPerShard: 3, topology: undefined })).toBeNull();
  });

  it("uses the same replication capabilities for selectable modes and validated mutations", () => {
    const postgres = cluster("postgres");
    const { nodes } = getClusterTopology(postgres);
    expect(clusterReplicationModes(postgres, nodes[0])).toEqual(["async", "sync"]);
    expect(clusterReplicationModes(postgres, nodes[1])).toEqual(["async"]);
    const synchronous = setReplicationMode(postgres, "replica-1-1", "sync");
    expect(restore(synchronous)).not.toBeNull();
    const cascading = setReplicationSource(synchronous, "replica-1-1", "replica-1-2");
    expect(
      getClusterTopology(cascading).edges.find((edge) => edge.target === "replica-1-1")?.mode,
    ).toBe("async");
    expect(() => setReplicationMode(cascading, "replica-1-1", "sync")).toThrow("does not support");
    const redis = cluster("redis");
    expect(clusterReplicationModes(redis, getClusterTopology(redis).nodes[0])).toEqual(["async"]);
    expect(() => setReplicationMode(redis, "replica-1-1", "sync")).toThrow("does not support");
  });

  it("rejects mixed engine settings and unsupported deployment modes in saved plans", () => {
    expect(restore({ ...cluster("postgres"), shards: 3 })).toBeNull();
    expect(restore({ ...cluster("redis"), replicas: 2 })).toBeNull();
    expect(restore({ ...database("postgres"), mode: "multi-primary" })).toBeNull();
    expect(restore({ ...database("redis"), kind: "mongodb" })).toBeNull();
    expect(restore({ ...database("redis"), topology: { nodes: [], edges: [] } })).toBeNull();
    expect(DATABASE_CATALOG.postgres.deployments.cluster.limits.primaries).toEqual({
      min: 1,
      max: 1,
    });
  });

  it("validates cluster capacity when the member validator is used independently", () => {
    expect(
      isClusterTopology(
        { nodes: [], edges: [] },
        { kind: "redis", shards: 0, replicasPerShard: 1 },
        REGIONS.map((region) => region.id),
      ),
    ).toBe(false);
    const resource = cluster("postgres");
    if (resource.kind !== "postgres") throw new Error("Expected PostgreSQL");
    expect(() => getClusterTopology({ ...resource, replicas: Number.POSITIVE_INFINITY })).toThrow(
      "read replicas",
    );
  });

  it("bounds imported plans by UTF-8 bytes, including multibyte input", () => {
    const serialized = JSON.stringify({
      version: 2,
      services: [],
      nodes: [],
      edges: [],
      description: "🙂".repeat(600_000),
    });
    expect(serialized.length).toBeLessThan(SCALE_CATALOG.limits.draftBytes);
    expect(parseDraft(serialized)).toBeNull();
  });
});
