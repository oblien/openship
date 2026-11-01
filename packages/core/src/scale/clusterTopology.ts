import {
  DATABASE_CATALOG,
  type ClusterAddition,
  type ClusterMemberRole,
  type DatabaseKind,
  type ReplicationMode,
} from "./catalog";
import type { ClusterResource, DatabaseResource } from "./topology";

export type ClusterMember = {
  id: string;
  name: string;
  role: ClusterMemberRole;
  shard: number;
  region: string;
  position: { x: number; y: number };
};
export type ClusterConnection = {
  id: string;
  source: string;
  target: string;
  mode: ReplicationMode;
};
export type ClusterTopology = { nodes: ClusterMember[]; edges: ClusterConnection[] };
type ClusterSpec =
  | { kind: "postgres"; replicas: number }
  | { kind: "redis"; shards: number; replicasPerShard: number };

function clusterSizeError(resource: ClusterSpec): string | null {
  if (resource.kind === "postgres") {
    const { min, max } = DATABASE_CATALOG.postgres.deployments.cluster.limits.replicas;
    if (!Number.isInteger(resource.replicas) || resource.replicas < min || resource.replicas > max)
      return `Choose between ${min} and ${max} read replicas.`;
  } else {
    const { shards, replicasPerShard } = DATABASE_CATALOG.redis.deployments.cluster.limits;
    if (
      !Number.isInteger(resource.shards) ||
      resource.shards < shards.min ||
      resource.shards > shards.max ||
      !Number.isInteger(resource.replicasPerShard) ||
      resource.replicasPerShard < replicasPerShard.min ||
      resource.replicasPerShard > replicasPerShard.max
    )
      return `Choose ${shards.min} to ${shards.max} primary shards and ${replicasPerShard.min} to ${replicasPerShard.max} replicas per shard.`;
  }
  return null;
}

function replication(kind: DatabaseKind, source: string, target: string): ClusterConnection {
  return {
    id: `replication:${encodeURIComponent(source)}:${encodeURIComponent(target)}`,
    source,
    target,
    mode: DATABASE_CATALOG[kind].deployments.cluster.replication.defaultMode,
  };
}

function buildTopology(resource: ClusterResource): ClusterTopology {
  const shards = resource.kind === "redis" ? resource.shards : 1;
  const replicas = resource.kind === "redis" ? resource.replicasPerShard : resource.replicas;
  const nodes: ClusterMember[] = [];
  const edges: ClusterConnection[] = [];
  for (let shard = 1; shard <= shards; shard += 1) {
    const y = (shard - 1) * (Math.max(1, replicas) * 180 + 80);
    const primary: ClusterMember = {
      id: `primary-${shard}`,
      name: resource.kind === "redis" ? `Shard ${shard} primary` : "Primary",
      role: "primary",
      shard,
      region: resource.region,
      position: { x: 0, y: y + (Math.max(1, replicas) - 1) * 90 },
    };
    nodes.push(primary);
    for (let ordinal = 1; ordinal <= replicas; ordinal += 1) {
      const replica: ClusterMember = {
        id: `replica-${shard}-${ordinal}`,
        name:
          resource.kind === "redis"
            ? `Shard ${shard} replica ${ordinal}`
            : `Read replica ${ordinal}`,
        role: "replica",
        shard,
        region: resource.region,
        position: { x: 360, y: y + (ordinal - 1) * 180 },
      };
      nodes.push(replica);
      edges.push(replication(resource.kind, primary.id, replica.id));
    }
  }
  return { nodes, edges };
}

// Older version-2 drafts have counts only. Materialize their members on the first edit.
export function getClusterTopology(resource: ClusterResource): ClusterTopology {
  const error = clusterSizeError(resource);
  if (error) throw new Error(error);
  return resource.topology ?? buildTopology(resource);
}

/** Actions and capacity for this deployment. Standalone databases cannot accept members. */
export function availableClusterAdditions(resource: DatabaseResource) {
  if (resource.mode !== "cluster") return [];
  const capacity =
    resource.kind === "postgres"
      ? {
          replicas: {
            value: resource.replicas,
            ...DATABASE_CATALOG.postgres.deployments.cluster.limits.replicas,
          },
        }
      : {
          shards: {
            value: resource.shards,
            ...DATABASE_CATALOG.redis.deployments.cluster.limits.shards,
          },
          replicasPerShard: {
            value: resource.replicasPerShard,
            ...DATABASE_CATALOG.redis.deployments.cluster.limits.replicasPerShard,
          },
        };
  return DATABASE_CATALOG[resource.kind].deployments.cluster.actions.map((action) => {
    const limit = capacity[action.field]!;
    const disabled = limit.value >= limit.max;
    const description =
      resource.kind === "redis"
        ? action.id === "add-shard"
          ? `One primary with ${resource.replicasPerShard} ${resource.replicasPerShard === 1 ? "replica" : "replicas"}`
          : `One new replica for each of the ${resource.shards} shards`
        : action.description;
    return {
      ...action,
      description,
      disabled,
      disabledReason: disabled
        ? `Limit reached: ${limit.max} ${action.field === "replicasPerShard" ? "replicas per shard" : action.field === "shards" ? "primary shards" : "read replicas"}.`
        : undefined,
    };
  });
}

/** A domain command, shared by UI and future application APIs. */
export function addClusterMember(
  resource: DatabaseResource,
  action: ClusterAddition,
): ClusterResource {
  const choice = availableClusterAdditions(resource).find((entry) => entry.id === action);
  if (resource.mode !== "cluster" || !choice)
    throw new Error("This database deployment does not support that action.");
  if (choice.disabled) throw new Error(choice.disabledReason);
  if (resource.kind === "postgres" && action === "add-replica")
    return configureCluster({ ...resource, replicas: resource.replicas + 1 }, resource);
  if (resource.kind === "redis" && action === "add-shard")
    return configureCluster({ ...resource, shards: resource.shards + 1 }, resource);
  if (resource.kind === "redis" && action === "add-replica-per-shard")
    return configureCluster(
      { ...resource, replicasPerShard: resource.replicasPerShard + 1 },
      resource,
    );
  throw new Error("This database deployment does not support that action.");
}

export function clusterReplicationModes(
  resource: Pick<ClusterResource, "kind">,
  source: ClusterMember,
): ReplicationMode[] {
  const rules = DATABASE_CATALOG[resource.kind].deployments.cluster.replication;
  if (!rules.sourceRoles.some((role) => role === source.role)) return [];
  return rules.modes.filter(
    (mode) => mode !== "sync" || rules.synchronousSourceRoles.some((role) => role === source.role),
  );
}

/** Resize without losing member placement, settings, or deliberately disconnected routes. */
export function configureCluster(
  resource: ClusterResource,
  previous: ClusterResource = resource,
): ClusterResource {
  const error = clusterSizeError(resource);
  if (error) throw new Error(error);
  if (resource.kind === "postgres" && !resource.replicas)
    resource = { ...resource, failover: false };
  const topology = getClusterTopology(previous);
  const shardCount = resource.kind === "redis" ? resource.shards : 1;
  const replicaCount = resource.kind === "redis" ? resource.replicasPerShard : resource.replicas;
  const primaries = topology.nodes
    .filter((node) => node.role === "primary")
    .sort((a, b) => a.shard - b.shard)
    .slice(0, shardCount);
  const usedIds = new Set(topology.nodes.map((node) => node.id));
  const nodes: ClusterMember[] = [];
  const addedEdges: ClusterConnection[] = [];
  let lastShard = Math.max(0, ...topology.nodes.map((node) => node.shard));
  let bottom = Math.max(-260, ...topology.nodes.map((node) => node.position.y));
  while (primaries.length < shardCount) {
    lastShard += 1;
    bottom += 260;
    primaries.push({
      id: `primary-${lastShard}`,
      name: `Shard ${lastShard} primary`,
      role: "primary",
      shard: lastShard,
      region: resource.region,
      position: { x: 0, y: bottom },
    });
  }
  for (const primary of primaries) {
    nodes.push(primary);
    const replicas = topology.nodes
      .filter((node) => node.role === "replica" && node.shard === primary.shard)
      .slice(0, replicaCount);
    while (replicas.length < replicaCount) {
      let ordinal = 1;
      while (usedIds.has(`replica-${primary.shard}-${ordinal}`)) ordinal += 1;
      const id = `replica-${primary.shard}-${ordinal}`;
      usedIds.add(id);
      const y = replicas.length
        ? Math.max(...replicas.map((node) => node.position.y)) + 180
        : primary.position.y;
      replicas.push({
        id,
        name:
          resource.kind === "redis"
            ? `Shard ${primary.shard} replica ${ordinal}`
            : `Read replica ${ordinal}`,
        role: "replica",
        shard: primary.shard,
        region: resource.region,
        position: { x: primary.position.x + 360, y },
      });
      addedEdges.push(replication(resource.kind, primary.id, id));
    }
    nodes.push(...replicas);
  }
  const kept = new Set(nodes.map((node) => node.id));
  const next: ClusterResource = {
    ...resource,
    topology: {
      nodes,
      edges: [
        ...topology.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
        ...addedEdges,
      ],
    },
  };
  const previousLayout = new Map(
    getClusterTopology(layoutCluster(previous)).nodes.map((node) => [node.id, node.position]),
  );
  const previousNodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const arranged = getClusterTopology(layoutCluster(next));
  // Make room when the standard layout grows, retaining every manually moved member.
  return {
    ...next,
    topology: {
      ...arranged,
      nodes: arranged.nodes.map((node) => {
        const existing = previousNodes.get(node.id);
        const position = previousLayout.get(node.id);
        return existing &&
          position &&
          (existing.position.x !== position.x || existing.position.y !== position.y)
          ? { ...node, position: existing.position }
          : node;
      }),
    },
  };
}

export function clusterConnectionError(
  resource: ClusterSpec,
  topology: ClusterTopology,
  sourceId: string,
  targetId: string,
): string | null {
  const source = topology.nodes.find((node) => node.id === sourceId);
  const target = topology.nodes.find((node) => node.id === targetId);
  if (!source || !target) return "Both members must belong to this cluster.";
  const rules = DATABASE_CATALOG[resource.kind].deployments.cluster.replication;
  if (sourceId === targetId) return "A member cannot replicate from itself.";
  if (target.role !== rules.targetRole) return "Replication connections must end at a replica.";
  if (
    !rules.sourceRoles.some((role) => role === source.role) ||
    (rules.sameShard && source.shard !== target.shard)
  )
    return resource.kind === "redis"
      ? "Connect each Redis replica to its shard’s primary."
      : "Connect members of the same replication group.";
  if (
    topology.edges.filter((edge) => edge.target === targetId).length >= rules.maxSourcesPerReplica
  )
    return "This replica already has a source. Disconnect it or change its replication source.";
  const pending = [targetId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === sourceId) return "This connection would create a replication loop.";
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of topology.edges) if (edge.source === id) pending.push(edge.target);
  }
  return null;
}

export function connectClusterMembers(
  resource: ClusterResource,
  source: string,
  target: string,
): ClusterResource {
  const topology = getClusterTopology(resource);
  const error = clusterConnectionError(resource, topology, source, target);
  if (error) throw new Error(error);
  return {
    ...resource,
    topology: {
      ...topology,
      edges: [...topology.edges, replication(resource.kind, source, target)],
    },
  };
}

export function setReplicationSource(
  resource: ClusterResource,
  target: string,
  source: string,
): ClusterResource {
  const topology = getClusterTopology(resource);
  const previous = topology.edges.find((edge) => edge.target === target);
  const disconnected = {
    ...resource,
    topology: { ...topology, edges: topology.edges.filter((edge) => edge.target !== target) },
  };
  if (!source) return disconnected;
  const connected = connectClusterMembers(disconnected, source, target);
  const sourceMember = topology.nodes.find((node) => node.id === source)!;
  return {
    ...connected,
    topology: {
      ...connected.topology!,
      edges: connected.topology!.edges.map((edge) =>
        edge.target === target
          ? {
              ...edge,
              mode:
                previous && clusterReplicationModes(resource, sourceMember).includes(previous.mode)
                  ? previous.mode
                  : DATABASE_CATALOG[resource.kind].deployments.cluster.replication.defaultMode,
            }
          : edge,
      ),
    },
  };
}

export function setReplicationMode(
  resource: ClusterResource,
  target: string,
  mode: ReplicationMode,
): ClusterResource {
  const topology = getClusterTopology(resource);
  const connection = topology.edges.find((edge) => edge.target === target);
  const source = topology.nodes.find((node) => node.id === connection?.source);
  if (!connection || !source)
    throw new Error("Connect this replica before setting its replication mode.");
  if (!clusterReplicationModes(resource, source).includes(mode))
    throw new Error("This replication source does not support that mode.");
  return {
    ...resource,
    topology: {
      ...topology,
      edges: topology.edges.map((edge) => (edge.id === connection.id ? { ...edge, mode } : edge)),
    },
  };
}

export function canRemoveClusterMember(resource: ClusterResource, member: ClusterMember) {
  const removal = DATABASE_CATALOG[resource.kind].deployments.cluster.roles[member.role].removal;
  return (
    removal === "member" ||
    (removal === "shard" &&
      resource.kind === "redis" &&
      resource.shards > DATABASE_CATALOG.redis.deployments.cluster.limits.shards.min)
  );
}

export function removeClusterMembers(resource: ClusterResource, ids: string[]): ClusterResource {
  const topology = getClusterTopology(resource);
  const removed = topology.nodes.filter((node) => ids.includes(node.id));
  const protectedMember = removed.find((node) => !canRemoveClusterMember(resource, node));
  if (protectedMember)
    throw new Error(
      resource.kind === "postgres"
        ? "The PostgreSQL primary must stay in the cluster."
        : protectedMember.role === "replica"
          ? "Resize replicas per shard in cluster settings."
          : `Keep at least ${DATABASE_CATALOG.redis.deployments.cluster.limits.shards.min} Redis primary shards.`,
    );
  const shards = new Set(removed.map((node) => node.shard));
  const nodes = topology.nodes.filter((node) =>
    resource.kind === "redis" ? !shards.has(node.shard) : !ids.includes(node.id),
  );
  const kept = new Set(nodes.map((node) => node.id));
  const nextTopology = {
    nodes,
    edges: topology.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
  };
  if (resource.kind === "postgres") {
    const replicas = nodes.length - 1;
    return {
      ...resource,
      replicas,
      failover: replicas > 0 && resource.failover,
      topology: nextTopology,
    };
  }
  const shardCount = nodes.filter((node) => node.role === "primary").length;
  if (shardCount < DATABASE_CATALOG.redis.deployments.cluster.limits.shards.min)
    throw new Error(
      `A Redis cluster needs at least ${DATABASE_CATALOG.redis.deployments.cluster.limits.shards.min} primary shards.`,
    );
  return { ...resource, shards: shardCount, topology: nextTopology };
}

export function layoutCluster(resource: ClusterResource): ClusterResource {
  const topology = getClusterTopology(resource);
  const positions = new Map<string, ClusterMember["position"]>();
  let y = 0;
  for (const primary of topology.nodes.filter((node) => node.role === "primary")) {
    const replicas = topology.nodes.filter(
      (node) => node.role === "replica" && node.shard === primary.shard,
    );
    positions.set(primary.id, { x: 0, y: y + (Math.max(1, replicas.length) - 1) * 90 });
    replicas.forEach((replica, index) => positions.set(replica.id, { x: 360, y: y + index * 180 }));
    y += Math.max(1, replicas.length) * 180 + 80;
  }
  return {
    ...resource,
    topology: {
      ...topology,
      nodes: topology.nodes.map((node) => ({ ...node, position: positions.get(node.id)! })),
    },
  };
}

export function clusterSlotRange(resource: ClusterResource, member: ClusterMember) {
  if (resource.kind !== "redis") return null;
  const slots = DATABASE_CATALOG.redis.deployments.cluster.sharding.hashSlots;
  const primaries = getClusterTopology(resource)
    .nodes.filter((node) => node.role === "primary")
    .sort((a, b) => a.shard - b.shard);
  const index = primaries.findIndex((node) => node.shard === member.shard);
  return {
    start: Math.floor((index * slots) / primaries.length),
    end: Math.floor(((index + 1) * slots) / primaries.length) - 1,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClusterTopology(
  value: unknown,
  resource: ClusterSpec,
  regions: readonly string[],
): value is ClusterTopology {
  if (clusterSizeError(resource)) return false;
  if (!record(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
  const shards = resource.kind === "postgres" ? 1 : resource.shards;
  const replicas = resource.kind === "postgres" ? resource.replicas : resource.replicasPerShard;
  if (value.nodes.length !== shards * (1 + replicas) || value.edges.length > shards * replicas)
    return false;
  const nodes: ClusterMember[] = [];
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (
      !record(node) ||
      typeof node.id !== "string" ||
      !node.id.trim() ||
      node.id.length > 120 ||
      ids.has(node.id) ||
      typeof node.name !== "string" ||
      !node.name.trim() ||
      node.name.length > 60 ||
      typeof node.role !== "string" ||
      !Object.hasOwn(DATABASE_CATALOG[resource.kind].deployments.cluster.roles, node.role) ||
      typeof node.shard !== "number" ||
      !Number.isInteger(node.shard) ||
      node.shard < 1 ||
      node.shard > 100000 ||
      typeof node.region !== "string" ||
      !regions.includes(node.region) ||
      !record(node.position) ||
      ![node.position.x, node.position.y].every(
        (coordinate) =>
          typeof coordinate === "number" &&
          Number.isFinite(coordinate) &&
          Math.abs(coordinate) <= 100000,
      )
    )
      return false;
    ids.add(node.id);
    nodes.push(node as ClusterMember);
  }
  const primaries = nodes.filter((node) => node.role === "primary");
  if (primaries.length !== shards || new Set(primaries.map((node) => node.shard)).size !== shards)
    return false;
  if (nodes.some((node) => !primaries.some((primary) => primary.shard === node.shard)))
    return false;
  if (
    primaries.some(
      (primary) =>
        nodes.filter((node) => node.role === "replica" && node.shard === primary.shard).length !==
        replicas,
    )
  )
    return false;
  const topology: ClusterTopology = { nodes, edges: [] };
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (
      !record(edge) ||
      typeof edge.id !== "string" ||
      !edge.id.trim() ||
      edge.id.length > 1000 ||
      edgeIds.has(edge.id) ||
      typeof edge.source !== "string" ||
      typeof edge.target !== "string" ||
      !nodes.some(
        (node) =>
          node.id === edge.source &&
          clusterReplicationModes(resource, node).some((mode) => mode === edge.mode),
      ) ||
      clusterConnectionError(resource, topology, edge.source, edge.target)
    )
      return false;
    edgeIds.add(edge.id);
    topology.edges.push(edge as ClusterConnection);
  }
  return true;
}
