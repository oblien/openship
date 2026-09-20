import { describe, expect, it } from "vitest";
import {
  clusterConnectionError,
  clusterSlotRange,
  configureCluster,
  connectClusterMembers,
  getClusterTopology,
  layoutCluster,
  removeClusterMembers,
  setReplicationSource,
} from "./clusterTopology";
import {
  createExampleDraft,
  createResource,
  draftReducer,
  isClusterResource,
  parseDraft,
  type DatabaseKind,
  type ClusterResource,
} from "./topology";

function cluster(kind: DatabaseKind = "postgres"): ClusterResource {
  const resource = createResource(kind, kind, 1, "cluster");
  if (!isClusterResource(resource)) throw new Error("Expected a cluster");
  return resource;
}
function roundtrip(resource: ClusterResource) {
  return parseDraft(JSON.stringify({ version: 2, services: [], nodes: [resource], edges: [] }));
}

describe("cluster member topology", () => {
  it.each(["postgres", "redis"] as const)(
    "opens count-only %s drafts without changing them",
    (kind) => {
      const resource = cluster(kind);
      const original = JSON.stringify(resource);
      const topology = getClusterTopology(resource);
      expect(topology.nodes.filter((node) => node.role === "primary")).toHaveLength(
        kind === "redis" ? 3 : 1,
      );
      expect(topology.nodes.filter((node) => node.role === "replica")).toHaveLength(
        kind === "redis" ? 3 : 2,
      );
      expect(topology.edges).toHaveLength(kind === "redis" ? 3 : 2);
      expect(
        new Set(topology.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size,
      ).toBe(topology.nodes.length);
      expect(JSON.stringify(resource)).toBe(original);
      expect(roundtrip(resource)?.nodes[0]).toEqual(resource);
      expect(roundtrip({ ...resource, topology })?.nodes[0]).toEqual({ ...resource, topology });
    },
  );

  it("preserves member edits and disconnected links when resizing or changing cluster settings", () => {
    const resource = cluster();
    if (resource.kind !== "postgres") throw new Error("Expected postgres");
    const topology = getClusterTopology(resource);
    const replica = {
      ...topology.nodes[1],
      name: "Analytics reader",
      region: "eu-west-1",
      position: { x: 800, y: 200 },
    };
    const customized = {
      ...resource,
      topology: {
        nodes: [topology.nodes[0], replica, topology.nodes[2]],
        edges: [topology.edges[1]],
      },
    };
    const resized = configureCluster(
      { ...customized, replicas: 3, region: "us-west-2" },
      customized,
    );
    const next = getClusterTopology(resized);
    expect(next.nodes.find((node) => node.id === replica.id)).toEqual(replica);
    expect(next.edges.some((edge) => edge.target === replica.id)).toBe(false);
    expect(next.nodes.at(-1)?.region).toBe("us-west-2");
    expect(next.edges).toHaveLength(2);
    expect(customized.topology.nodes).toHaveLength(3);
    expect(roundtrip(resized)?.nodes[0]).toEqual(resized);
  });

  it("adds Redis shards with their replicas and scales all shards together", () => {
    const original = cluster("redis");
    if (original.kind !== "redis") throw new Error("Expected redis");
    const resized = configureCluster({ ...original, shards: 4, replicasPerShard: 2 }, original);
    const topology = getClusterTopology(resized);
    expect(topology.nodes).toHaveLength(12);
    expect(topology.edges).toHaveLength(8);
    for (const [index, node] of topology.nodes.entries())
      for (const other of topology.nodes.slice(index + 1))
        expect(
          Math.abs(node.position.x - other.position.x) >= 224 ||
            Math.abs(node.position.y - other.position.y) >= 140,
        ).toBe(true);
    for (const primary of topology.nodes.filter((node) => node.role === "primary"))
      expect(topology.edges.filter((edge) => edge.source === primary.id)).toHaveLength(2);
    expect(roundtrip(resized)?.nodes[0]).toEqual(resized);
  });

  it("removes a specific replica and its incident connections while retaining other members", () => {
    const original = setReplicationSource(cluster(), "replica-1-2", "replica-1-1");
    const next = removeClusterMembers(original, ["replica-1-1"]);
    expect(next).toMatchObject({ replicas: 1, failover: true });
    expect(getClusterTopology(next).nodes.map((node) => node.id)).toEqual([
      "primary-1",
      "replica-1-2",
    ]);
    expect(getClusterTopology(next).edges).toHaveLength(0);
    expect(removeClusterMembers(next, ["replica-1-2"])).toMatchObject({
      replicas: 0,
      failover: false,
    });
    expect(() => removeClusterMembers(next, ["primary-1"])).toThrow();
    expect(roundtrip(next)).not.toBeNull();
  });

  it("removes a Redis shard as a group and reallocates every hash slot", () => {
    const original = cluster("redis");
    if (original.kind !== "redis") throw new Error("Expected redis");
    const expanded = configureCluster({ ...original, shards: 4 }, original);
    const next = removeClusterMembers(expanded, ["primary-2"]);
    const topology = getClusterTopology(next);
    expect(next).toMatchObject({ shards: 3 });
    expect(topology.nodes).toHaveLength(6);
    expect(topology.nodes.some((node) => node.shard === 2)).toBe(false);
    expect(topology.edges).toHaveLength(3);
    const slots = topology.nodes
      .filter((node) => node.role === "primary")
      .map((node) => clusterSlotRange(next, node)!);
    expect(slots[0].start).toBe(0);
    expect(slots.at(-1)?.end).toBe(16383);
    expect(slots.reduce((total, range) => total + range.end - range.start + 1, 0)).toBe(16384);
    expect(slots[1].start).toBe(slots[0].end + 1);
    expect(() => removeClusterMembers(next, ["primary-1"])).toThrow();
    expect(() => removeClusterMembers(next, ["replica-1-1"])).toThrow();
    expect(roundtrip(next)).not.toBeNull();
  });

  it("layouts only the members and preserves their configuration and replication links", () => {
    const original = cluster();
    const topology = getClusterTopology(original);
    topology.nodes[1] = {
      ...topology.nodes[1],
      name: "Reporting",
      region: "eu-west-1",
      position: { x: -500, y: 1000 },
    };
    const next = layoutCluster({ ...original, topology });
    expect(next.position).toEqual(original.position);
    expect(next.topology?.nodes[1]).toMatchObject({ name: "Reporting", region: "eu-west-1" });
    expect(next.topology?.nodes[1].position).not.toEqual(topology.nodes[1].position);
    expect(next.topology?.edges).toEqual(topology.edges);
  });
});

describe("replication connections", () => {
  it("edits a replica source atomically and rejects cycles, duplicate sources, and outside members", () => {
    const original = cluster();
    const cascaded = setReplicationSource(original, "replica-1-2", "replica-1-1");
    expect(getClusterTopology(cascaded).edges).toContainEqual(
      expect.objectContaining({ source: "replica-1-1", target: "replica-1-2" }),
    );
    expect(() => setReplicationSource(cascaded, "replica-1-1", "replica-1-2")).toThrow(/loop/);
    expect(() => connectClusterMembers(cascaded, "primary-1", "replica-1-2")).toThrow(
      /already has a source/,
    );
    expect(() => setReplicationSource(cascaded, "replica-1-1", "replica-1-1")).toThrow(/itself/);
    expect(() => connectClusterMembers(cascaded, "api-instance-1", "replica-1-1")).toThrow(
      /belong/,
    );
    expect(() => connectClusterMembers(cascaded, "replica-1-1", "primary-1")).toThrow(
      /end at a replica/,
    );
    const disconnected = setReplicationSource(cascaded, "replica-1-1", "");
    expect(getClusterTopology(disconnected).edges).toHaveLength(1);
    expect(
      getClusterTopology(connectClusterMembers(disconnected, "primary-1", "replica-1-1")).edges,
    ).toHaveLength(2);
    expect(roundtrip(cascaded)).not.toBeNull();
  });

  it("uses asynchronous replication for a cascading standby", () => {
    const resource = cluster();
    const topology = getClusterTopology(resource);
    topology.edges[1].mode = "sync";
    const next = setReplicationSource({ ...resource, topology }, "replica-1-2", "replica-1-1");
    expect(next.topology?.edges.find((edge) => edge.target === "replica-1-2")?.mode).toBe("async");
  });

  it("keeps Redis replication within a shard", () => {
    const resource = cluster("redis");
    const disconnected = setReplicationSource(resource, "replica-1-1", "");
    const topology = getClusterTopology(disconnected);
    expect(clusterConnectionError(resource, topology, "primary-1", "replica-1-1")).toBeNull();
    expect(clusterConnectionError(resource, topology, "primary-2", "replica-1-1")).toMatch(/shard/);
    expect(clusterConnectionError(resource, topology, "replica-2-1", "replica-1-1")).toMatch(
      /shard/,
    );
  });
});

describe("nested draft persistence", () => {
  it.each([
    "missing member",
    "duplicate member",
    "unknown role",
    "invalid region",
    "invalid position",
    "duplicate edge",
    "outside connection",
    "primary target",
    "cycle",
    "invalid mode",
    "wrong count",
  ])("rejects %s in a stored cluster", (problem) => {
    const resource = cluster();
    const topology = getClusterTopology(resource);
    if (problem === "missing member") topology.nodes.pop();
    if (problem === "duplicate member") topology.nodes[1].id = topology.nodes[0].id;
    if (problem === "unknown role") Object.assign(topology.nodes[1], { role: "writer" });
    if (problem === "invalid region") topology.nodes[1].region = "unknown";
    if (problem === "invalid position") topology.nodes[1].position.x = Infinity;
    if (problem === "duplicate edge") topology.edges[1].id = topology.edges[0].id;
    if (problem === "outside connection") topology.edges[0].source = "postgres";
    if (problem === "primary target") topology.edges[0].target = "primary-1";
    if (problem === "cycle") {
      topology.edges[0].source = "replica-1-2";
      topology.edges[1].source = "replica-1-1";
    }
    if (problem === "invalid mode") Object.assign(topology.edges[0], { mode: "unknown" });
    if (problem === "wrong count") Object.assign(resource, { replicas: 3 });
    expect(roundtrip({ ...resource, topology })).toBeNull();
  });

  it("rejects synchronous Redis links and synchronous cascading standbys", () => {
    const redis = cluster("redis");
    const redisTopology = getClusterTopology(redis);
    redisTopology.edges[0].mode = "sync";
    expect(roundtrip({ ...redis, topology: redisTopology })).toBeNull();
    const postgres = setReplicationSource(cluster(), "replica-1-2", "replica-1-1");
    postgres.topology!.edges.find((edge) => edge.target === "replica-1-2")!.mode = "sync";
    expect(roundtrip(postgres)).toBeNull();
  });

  it("round-trips and undoes cluster edits without touching overview nodes or service routes", () => {
    const draft = createExampleDraft();
    const resource = draft.nodes.find((node) => node.id === "postgres")!;
    if (!isClusterResource(resource)) throw new Error("Expected a cluster");
    const updated = setReplicationSource(resource, "replica-1-2", "replica-1-1");
    const changed = draftReducer(
      { present: draft, past: [], future: [] },
      {
        type: "change",
        draft: {
          ...draft,
          nodes: draft.nodes.map((node) => (node.id === updated.id ? updated : node)),
        },
      },
    );
    expect(changed.present.nodes).toHaveLength(draft.nodes.length);
    expect(changed.present.edges).toBe(draft.edges);
    expect(changed.present.nodes.map((node) => node.position)).toEqual(
      draft.nodes.map((node) => node.position),
    );
    expect(parseDraft(JSON.stringify(changed.present))).toEqual(changed.present);
    const undone = draftReducer(changed, { type: "undo" });
    expect(undone.present).toBe(draft);
    expect(draftReducer(undone, { type: "redo" }).present).toBe(changed.present);
  });

  it("accepts the maximum cluster capacity while bounding malformed payloads", () => {
    const resource = cluster("redis");
    if (resource.kind !== "redis") throw new Error("Expected redis");
    const maximal = configureCluster({ ...resource, shards: 12, replicasPerShard: 2 }, resource);
    const draft = {
      version: 2,
      services: [],
      edges: [],
      nodes: Array.from({ length: 60 }, (_, index) => ({ ...maximal, id: `redis-${index}` })),
    };
    expect(parseDraft(JSON.stringify(draft))?.nodes).toHaveLength(60);
    expect(parseDraft(" ".repeat(2_000_001))).toBeNull();
    expect(() => configureCluster({ ...resource, shards: 13 }, resource)).toThrow();
  });
});
