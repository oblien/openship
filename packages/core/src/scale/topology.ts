import { isClusterTopology, type ClusterTopology } from "./clusterTopology";
import {
  ALGORITHMS,
  APPLICATION_TYPES,
  CONNECTION_PROTOCOLS,
  CONNECTION_TARGETS,
  DATABASE_CATALOG,
  DATABASE_ENGINES,
  RESOURCE_CATALOG,
  SCALE_CATALOG,
  SCALE_LIMITS,
  isDatabaseKind,
  type ConnectionProtocol,
  type DatabaseKind,
  type DatabaseMode,
  type ResourceKind,
} from "./catalog";

export * from "./catalog";

export const REGIONS = [
  { id: "us-east-1", name: "Virginia, US", short: "US East" },
  { id: "us-west-2", name: "Oregon, US", short: "US West" },
  { id: "eu-west-1", name: "Dublin, Ireland", short: "EU West" },
  { id: "ap-southeast-1", name: "Singapore", short: "Asia Pacific" },
] as const;

type ResourceBase = {
  id: string;
  name: string;
  region: string;
  position: { x: number; y: number };
};
export type ScaleResource = ResourceBase &
  (
    | {
        kind: "edge";
        tls: boolean;
        algorithm: keyof typeof ALGORITHMS;
        healthPath: string;
        healthInterval: number;
      }
    | { kind: "service"; serviceId: string; ordinal: number }
    | { kind: "postgres"; mode: "standalone"; cpu: number; memory: number; storage: number }
    | { kind: "redis"; mode: "standalone"; cpu: number; memory: number }
    | {
        kind: "postgres";
        mode: "cluster";
        replicas: number;
        failover: boolean;
        topology?: ClusterTopology;
      }
    | {
        kind: "redis";
        mode: "cluster";
        shards: number;
        replicasPerShard: number;
        topology?: ClusterTopology;
      }
  );
export type DatabaseResource = Extract<ScaleResource, { kind: DatabaseKind }>;
export type ClusterResource = Extract<DatabaseResource, { mode: "cluster" }>;
export function isDatabaseResource(resource: ScaleResource): resource is DatabaseResource {
  return isDatabaseKind(resource.kind);
}
export function isClusterResource(resource: ScaleResource): resource is ClusterResource {
  return isDatabaseResource(resource) && resource.mode === "cluster";
}
export type ScaleService = {
  id: string;
  name: string;
  applicationType: keyof typeof APPLICATION_TYPES;
  port: number;
  cpu: number;
  memory: number;
  autoscale: boolean;
  minReplicas: number;
  maxReplicas: number;
  targetCpu: number;
};
export type ConnectionOptions = {
  label?: string;
  protocol?: ConnectionProtocol;
  port?: number;
  enabled?: boolean;
};
export type ScaleConnection = { id: string; source: string; target: string } & ConnectionOptions;
export type ScaleDraft = {
  version: typeof SCALE_CATALOG.draftVersion;
  services: ScaleService[];
  nodes: ScaleResource[];
  edges: ScaleConnection[];
};
export type ScaleSelection = { type: "node" | "edge"; id: string } | null;
export type PlanIssue = { nodeId?: string; message: string; severity: "warning" | "info" };
export const MAX_RESOURCES = SCALE_LIMITS.resources;
export const MAX_CONNECTIONS = SCALE_LIMITS.connections;
export const MAX_INSTANCES = SCALE_LIMITS.instances;

export function createResource(
  kind: Exclude<ResourceKind, "service">,
  id: string,
  ordinal = 1,
  mode: DatabaseMode = "standalone",
): ScaleResource {
  const base = {
    id,
    name: `${kind}${isDatabaseKind(kind) && mode === "cluster" ? "-cluster" : ""}-${ordinal}`,
    region: "us-east-1",
    position: { x: kind === "edge" ? 0 : 680, y: (ordinal - 1) * 240 },
  };
  switch (kind) {
    case "edge":
      return {
        ...base,
        kind,
        ...RESOURCE_CATALOG.edge.defaults,
      };
    case "postgres":
      return mode === "cluster"
        ? { ...base, kind, mode, ...DATABASE_CATALOG.postgres.deployments.cluster.defaults }
        : { ...base, kind, mode, ...DATABASE_CATALOG.postgres.deployments.standalone.defaults };
    case "redis":
      return mode === "cluster"
        ? { ...base, kind, mode, ...DATABASE_CATALOG.redis.deployments.cluster.defaults }
        : { ...base, kind, mode, ...DATABASE_CATALOG.redis.deployments.standalone.defaults };
  }
}

export function createService(id: string, name = "application"): ScaleService {
  return {
    id,
    name,
    ...RESOURCE_CATALOG.service.defaults,
  };
}

export function serviceInstances(draft: ScaleDraft, serviceId: string) {
  return draft.nodes
    .filter(
      (node): node is Extract<ScaleResource, { kind: "service" }> =>
        node.kind === "service" && node.serviceId === serviceId,
    )
    .sort((first, second) => first.ordinal - second.ordinal);
}

function createInstance(
  service: ScaleService,
  ordinal: number,
  position: ResourceBase["position"],
  region = "us-east-1",
): ScaleResource {
  return {
    id: `${service.id}-instance-${ordinal}`,
    kind: "service",
    name: `${service.name}-${ordinal}`,
    serviceId: service.id,
    ordinal,
    region,
    position,
  };
}

export function addService(
  draft: ScaleDraft,
  service: ScaleService,
  count: number = RESOURCE_CATALOG.service.initialInstances,
): ScaleDraft {
  if (!isService(service)) throw new Error("Check the application configuration.");
  if (draft.services.some((entry) => entry.id === service.id))
    throw new Error("This application already exists.");
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_INSTANCES ||
    draft.nodes.length + count > MAX_RESOURCES
  )
    throw new Error("This draft has reached its instance limit.");
  if (service.autoscale && (count < service.minReplicas || count > service.maxReplicas))
    throw new Error("The instance count must stay within the autoscaling bounds.");
  const bottom = Math.max(
    -180,
    ...draft.nodes.filter((node) => node.kind === "service").map((node) => node.position.y),
  );
  const nodes = Array.from({ length: count }, (_entry, index) =>
    createInstance(service, index + 1, { x: 340, y: bottom + 180 * (index + 1) }),
  );
  if (nodes.some((instance) => draft.nodes.some((node) => node.id === instance.id)))
    throw new Error("An instance identifier is already in use.");
  return { ...draft, services: [...draft.services, service], nodes: [...draft.nodes, ...nodes] };
}

export function instanceCount(resource: ScaleResource): number {
  if (!isClusterResource(resource)) return 1;
  return resource.kind === "postgres"
    ? 1 + resource.replicas
    : resource.shards * (1 + resource.replicasPerShard);
}

export function summarizeDraft(draft: ScaleDraft) {
  return {
    gateways: draft.nodes.filter((node) => node.kind === "edge").length,
    applications: draft.services.length,
    instances: draft.nodes.filter((node) => node.kind === "service").length,
    databases: draft.nodes.filter((node) => node.kind === "postgres" || node.kind === "redis")
      .length,
    total: draft.nodes.reduce((total, node) => total + instanceCount(node), 0),
  };
}

export function redisSlotRanges(shards: number) {
  const slots = DATABASE_CATALOG.redis.deployments.cluster.sharding.hashSlots;
  return Array.from({ length: shards }, (_entry, index) => ({
    shard: index + 1,
    start: Math.floor((index * slots) / shards),
    end: Math.floor(((index + 1) * slots) / shards) - 1,
  }));
}

function pairError(draft: ScaleDraft, sourceId: string, targetId: string): string | null {
  const source = draft.nodes.find((node) => node.id === sourceId);
  const target = draft.nodes.find((node) => node.id === targetId);
  if (!source || !target) return "Both resources must exist in the topology.";
  if (sourceId === targetId) return "A resource cannot connect to itself.";
  const allowed = CONNECTION_TARGETS[source.kind].includes(target.kind);
  if (!allowed)
    return "Connect OpenShip Edge to gateways or application instances, and applications to data stores.";
  if (draft.edges.some((edge) => edge.source === sourceId && edge.target === targetId))
    return "These resources are already connected.";
  const pending = [targetId];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === sourceId) return "This connection would create a routing loop.";
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of draft.edges) if (edge.source === current) pending.push(edge.target);
  }
  return null;
}

function makeConnection(source: string, target: string): ScaleConnection {
  return {
    id: `route:${encodeURIComponent(source)}:${encodeURIComponent(target)}`,
    source,
    target,
  };
}

export function connectionError(draft: ScaleDraft, source: string, target: string): string | null {
  const error = pairError(draft, source, target);
  if (error) return error;
  if (draft.edges.length >= MAX_CONNECTIONS)
    return "This connection would exceed the draft connection limit.";
  return null;
}

export function connectResources(draft: ScaleDraft, source: string, target: string): ScaleDraft {
  const error = connectionError(draft, source, target);
  if (error) throw new Error(error);
  return {
    ...draft,
    edges: [...draft.edges, makeConnection(source, target)],
  };
}

export function removeConnections(draft: ScaleDraft, ids: string[]): ScaleDraft {
  const removed = new Set(ids);
  return {
    ...draft,
    edges: draft.edges.filter((edge) => !removed.has(edge.id)),
  };
}

export function connectionProtocols(target: ScaleResource): ConnectionProtocol[] {
  return [...RESOURCE_CATALOG[target.kind].connection.protocols];
}

export function getConnectionSettings(
  draft: ScaleDraft,
  target: ScaleResource,
  options: ConnectionOptions = {},
): Required<ConnectionOptions> {
  const protocol =
    options.protocol ??
    (target.kind === "edge" && !target.tls
      ? "http"
      : RESOURCE_CATALOG[target.kind].connection.defaultProtocol);
  const port =
    options.port ??
    (isDatabaseResource(target)
      ? DATABASE_CATALOG[target.kind].connection.defaultPort
      : target.kind === "service"
        ? (draft.services.find((service) => service.id === target.serviceId)?.port ??
          RESOURCE_CATALOG.service.connection.defaultPort)
        : protocol === "https"
          ? 443
          : 80);
  return { label: options.label ?? "", protocol, port, enabled: options.enabled ?? true };
}

export function connectionLabel(
  draft: ScaleDraft,
  target: ScaleResource,
  options: ConnectionOptions = {},
): string {
  const { protocol, port, enabled } = getConnectionSettings(draft, target, options);
  const type = isDatabaseResource(target)
    ? `${DATABASE_ENGINES[target.kind]}${protocol === "tls" ? " (TLS)" : ""}`
    : CONNECTION_PROTOCOLS[protocol];
  return `${enabled ? "" : "Disabled · "}${type} · ${port}`;
}

function isConnectionOptions(
  value: Record<string, unknown>,
  target: ScaleResource,
): value is Record<string, unknown> & ConnectionOptions {
  return (
    (value.label === undefined || (typeof value.label === "string" && value.label.length <= 60)) &&
    (value.protocol === undefined ||
      connectionProtocols(target).some((protocol) => protocol === value.protocol)) &&
    (value.port === undefined || integer(value.port, 1, 65535)) &&
    (value.enabled === undefined || typeof value.enabled === "boolean")
  );
}

export function configureConnection(
  draft: ScaleDraft,
  id: string,
  options: ConnectionOptions,
): ScaleDraft {
  const connection = draft.edges.find((edge) => edge.id === id);
  const target = draft.nodes.find((node) => node.id === connection?.target);
  if (!connection || !target) throw new Error("This connection no longer exists.");
  const next = { ...connection, ...options };
  if (!isConnectionOptions(next, target)) throw new Error("Check the connection settings.");
  return { ...draft, edges: draft.edges.map((edge) => (edge.id === id ? next : edge)) };
}

export function configureService(
  draft: ScaleDraft,
  service: ScaleService,
  count = serviceInstances(draft, service.id).length,
): ScaleDraft {
  if (!isService(service)) throw new Error("Check the application configuration.");
  const previous = serviceInstances(draft, service.id);
  if (!previous.length) throw new Error("This application no longer exists.");
  if (!Number.isInteger(count) || count < 1 || count > MAX_INSTANCES)
    throw new Error(`Choose between 1 and ${MAX_INSTANCES} instances.`);
  if (draft.nodes.length - previous.length + count > MAX_RESOURCES)
    throw new Error("This draft has reached its instance limit.");
  if (service.autoscale && (count < service.minReplicas || count > service.maxReplicas))
    throw new Error("The instance count must stay within the autoscaling bounds.");
  const kept = new Set(previous.slice(0, count).map((node) => node.id));
  const nodes = draft.nodes
    .filter((node) => node.kind !== "service" || node.serviceId !== service.id || kept.has(node.id))
    .map((node) =>
      node.kind === "service" && node.serviceId === service.id
        ? { ...node, name: `${service.name}-${node.ordinal}` }
        : node,
    );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = draft.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const last = previous.at(-1)!;
  const addedCount = Math.max(0, count - previous.length);
  for (let index = 0; index < addedCount; index += 1) {
    const instance = createInstance(
      service,
      last.ordinal + index + 1,
      { x: last.position.x, y: last.position.y + (index + 1) * 180 },
      last.region,
    );
    if (nodeIds.has(instance.id)) throw new Error("An instance identifier is already in use.");
    nodes.push(instance);
  }
  return {
    ...draft,
    services: draft.services.map((entry) => (entry.id === service.id ? service : entry)),
    nodes,
    edges,
  };
}

export function removeResources(draft: ScaleDraft, ids: string[]): ScaleDraft {
  const removed = new Set(ids);
  const nodes = draft.nodes.filter((node) => !removed.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const services = draft.services.flatMap((service) => {
    const remaining = nodes.filter(
      (node) => node.kind === "service" && node.serviceId === service.id,
    ).length;
    return remaining ? [{ ...service, minReplicas: Math.min(service.minReplicas, remaining) }] : [];
  });
  return {
    ...draft,
    nodes,
    services,
    edges: draft.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  };
}

export function layoutDraft(draft: ScaleDraft): ScaleDraft {
  const layers = [
    draft.nodes.filter((node) => node.kind === "edge"),
    draft.nodes.filter((node) => node.kind === "service"),
    draft.nodes.filter((node) => node.kind === "postgres" || node.kind === "redis"),
  ];
  const spacing = [250, 180, 300];
  const heights = layers.map((layer, index) => layer.length * spacing[index]);
  const height = Math.max(...heights);
  const positions = new Map(
    layers.flatMap((layer, layerIndex) =>
      layer.map(
        (node, index) =>
          [
            node.id,
            {
              x: layerIndex * 340,
              y: (height - heights[layerIndex]) / 2 + index * spacing[layerIndex],
            },
          ] as const,
      ),
    ),
  );
  return {
    ...draft,
    nodes: draft.nodes.map((node) => ({ ...node, position: positions.get(node.id)! })),
  };
}

export function createExampleDraft(): ScaleDraft {
  let draft: ScaleDraft = {
    version: 2,
    services: [],
    edges: [],
    nodes: [
      { ...createResource("edge", "edge-us"), name: "edge-us" },
      { ...createResource("edge", "edge-eu", 2), name: "edge-eu", region: "eu-west-1" },
      { ...createResource("postgres", "postgres", 1, "cluster"), name: "postgres" },
      { ...createResource("redis", "redis", 1, "cluster"), name: "redis" },
    ],
  };
  draft = addService(draft, createService("api", "api"));
  for (const instance of serviceInstances(draft, "api")) {
    draft = connectResources(draft, "edge-us", instance.id);
    draft = connectResources(draft, "edge-eu", instance.id);
    draft = connectResources(draft, instance.id, "postgres");
    draft = connectResources(draft, instance.id, "redis");
  }
  return layoutDraft(draft);
}

export function reviewDraft(draft: ScaleDraft): PlanIssue[] {
  if (!draft.nodes.length)
    return [
      {
        message: "Add OpenShip Edge or an application to start the topology.",
        severity: "warning",
      },
    ];
  const issues: PlanIssue[] = [];
  const connections = draft.edges.filter((edge) => edge.enabled !== false);
  const reachable = new Set(
    draft.nodes.filter((node) => node.kind === "edge").map((node) => node.id),
  );
  for (let pass = 0; pass < draft.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of connections)
      if (reachable.has(edge.source) && !reachable.has(edge.target)) {
        reachable.add(edge.target);
        changed = true;
      }
    if (!changed) break;
  }
  for (const node of draft.nodes) {
    if (node.kind !== "edge" && !reachable.has(node.id))
      issues.push({
        nodeId: node.id,
        message: `${node.name} has no route from OpenShip Edge.`,
        severity: "warning",
      });
    if (node.kind === "edge" && !connections.some((edge) => edge.source === node.id))
      issues.push({
        nodeId: node.id,
        message: `${node.name} has no upstream application or gateway.`,
        severity: "warning",
      });
    if (node.kind === "edge" && !node.tls)
      issues.push({
        nodeId: node.id,
        message: `${node.name} needs external TLS termination.`,
        severity: "warning",
      });
    if (isClusterResource(node) && node.kind === "postgres" && !node.replicas)
      issues.push({
        nodeId: node.id,
        message: `${node.name} has no read replica or failover target.`,
        severity: "warning",
      });
  }
  if (draft.nodes.filter((node) => node.kind === "edge").length === 1)
    issues.push({
      message:
        "One OpenShip Edge gateway is a single point of failure. Add a second gateway for redundancy.",
      severity: "info",
    });
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}
function name(value: unknown, maximum = 120): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= maximum;
}

function isService(value: unknown): value is ScaleService {
  return (
    isRecord(value) &&
    name(value.id) &&
    name(value.name, 60) &&
    typeof value.applicationType === "string" &&
    Object.hasOwn(APPLICATION_TYPES, value.applicationType) &&
    integer(value.port, 1, 65535) &&
    typeof value.cpu === "number" &&
    RESOURCE_CATALOG.service.limits.cpu.some((cpu) => cpu === value.cpu) &&
    typeof value.memory === "number" &&
    RESOURCE_CATALOG.service.limits.memory.some((memory) => memory === value.memory) &&
    typeof value.autoscale === "boolean" &&
    integer(value.minReplicas, 1, MAX_INSTANCES) &&
    integer(value.maxReplicas, value.minReplicas, MAX_INSTANCES) &&
    integer(
      value.targetCpu,
      RESOURCE_CATALOG.service.limits.targetCpu.min,
      RESOURCE_CATALOG.service.limits.targetCpu.max,
    )
  );
}

function isResource(value: unknown): value is ScaleResource {
  if (
    !isRecord(value) ||
    !name(value.id, 160) ||
    !name(value.name, 70) ||
    !REGIONS.some((region) => region.id === value.region) ||
    !isRecord(value.position) ||
    ![value.position.x, value.position.y].every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= 100000,
    )
  )
    return false;
  if (value.kind === "postgres" || value.kind === "redis") {
    const definition = DATABASE_CATALOG[value.kind];
    if (value.mode === "standalone")
      return (
        definition.deployments.standalone.limits.cpu.some((cpu) => cpu === value.cpu) &&
        definition.deployments.standalone.limits.memory.some((memory) => memory === value.memory) &&
        ["topology", "replicas", "failover", "shards", "replicasPerShard"].every(
          (field) => value[field] === undefined,
        ) &&
        (value.kind === "postgres"
          ? integer(
              value.storage,
              DATABASE_CATALOG.postgres.deployments.standalone.limits.storage.min,
              DATABASE_CATALOG.postgres.deployments.standalone.limits.storage.max,
            )
          : value.storage === undefined)
      );
    if (
      value.mode !== "cluster" ||
      value.cpu !== undefined ||
      value.memory !== undefined ||
      value.storage !== undefined
    )
      return false;
  }
  switch (value.kind) {
    case "edge":
      return (
        typeof value.tls === "boolean" &&
        typeof value.algorithm === "string" &&
        Object.hasOwn(ALGORITHMS, value.algorithm) &&
        typeof value.healthPath === "string" &&
        value.healthPath.startsWith("/") &&
        value.healthPath.length <= 200 &&
        integer(
          value.healthInterval,
          RESOURCE_CATALOG.edge.limits.healthInterval.min,
          RESOURCE_CATALOG.edge.limits.healthInterval.max,
        )
      );
    case "service":
      return name(value.serviceId) && integer(value.ordinal, 1, 100000);
    case "postgres":
      return (
        integer(
          value.replicas,
          DATABASE_CATALOG.postgres.deployments.cluster.limits.replicas.min,
          DATABASE_CATALOG.postgres.deployments.cluster.limits.replicas.max,
        ) &&
        typeof value.failover === "boolean" &&
        (!value.failover ||
          value.replicas >=
            DATABASE_CATALOG.postgres.deployments.cluster.failover.minimumReplicas) &&
        value.shards === undefined &&
        value.replicasPerShard === undefined &&
        (value.topology === undefined ||
          isClusterTopology(
            value.topology,
            { kind: "postgres", replicas: value.replicas },
            REGIONS.map((region) => region.id),
          ))
      );
    case "redis":
      return (
        integer(
          value.shards,
          DATABASE_CATALOG.redis.deployments.cluster.limits.shards.min,
          DATABASE_CATALOG.redis.deployments.cluster.limits.shards.max,
        ) &&
        integer(
          value.replicasPerShard,
          DATABASE_CATALOG.redis.deployments.cluster.limits.replicasPerShard.min,
          DATABASE_CATALOG.redis.deployments.cluster.limits.replicasPerShard.max,
        ) &&
        value.replicas === undefined &&
        value.failover === undefined &&
        (value.topology === undefined ||
          isClusterTopology(
            value.topology,
            { kind: "redis", shards: value.shards, replicasPerShard: value.replicasPerShard },
            REGIONS.map((region) => region.id),
          ))
      );
    default:
      return false;
  }
}

export function parseDraft(serialized: string): ScaleDraft | null {
  if (
    serialized.length > SCALE_LIMITS.draftBytes ||
    new TextEncoder().encode(serialized).byteLength > SCALE_LIMITS.draftBytes
  )
    return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.version !== SCALE_CATALOG.draftVersion ||
      !Array.isArray(value.nodes) ||
      !Array.isArray(value.services) ||
      !Array.isArray(value.edges) ||
      value.nodes.length > MAX_RESOURCES ||
      value.services.length > MAX_RESOURCES ||
      value.edges.length > MAX_CONNECTIONS ||
      !value.services.every(isService)
    )
      return null;
    // Before deployment modes existed, every saved database was a cluster.
    const nodes = value.nodes.map((node: unknown) =>
      isRecord(node) &&
      (node.kind === "postgres" || node.kind === "redis") &&
      node.mode === undefined
        ? { ...node, mode: "cluster" }
        : node,
    );
    if (!nodes.every(isResource)) return null;
    const draft: ScaleDraft = {
      version: 2,
      nodes,
      services: value.services,
      edges: [],
    };
    if (
      new Set(draft.nodes.map((node) => node.id)).size !== draft.nodes.length ||
      new Set(draft.services.map((service) => service.id)).size !== draft.services.length
    )
      return null;
    for (const service of draft.services) {
      const instances = serviceInstances(draft, service.id);
      if (
        !instances.length ||
        instances.length > MAX_INSTANCES ||
        new Set(instances.map((node) => node.ordinal)).size !== instances.length ||
        (service.autoscale &&
          (instances.length < service.minReplicas || instances.length > service.maxReplicas))
      )
        return null;
    }
    for (const node of draft.nodes) {
      if (
        node.kind === "service" &&
        !draft.services.some(
          (service) =>
            service.id === node.serviceId && node.name === `${service.name}-${node.ordinal}`,
        )
      )
        return null;
    }
    const ids = new Set<string>();
    for (const edge of value.edges) {
      if (
        !isRecord(edge) ||
        !name(edge.id, 1000) ||
        ids.has(edge.id) ||
        typeof edge.source !== "string" ||
        typeof edge.target !== "string" ||
        pairError(draft, edge.source, edge.target)
      )
        return null;
      const target = draft.nodes.find((node) => node.id === edge.target)!;
      if (!isConnectionOptions(edge, target)) return null;
      ids.add(edge.id);
      draft.edges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label !== undefined && { label: edge.label }),
        ...(edge.protocol !== undefined && { protocol: edge.protocol }),
        ...(edge.port !== undefined && { port: edge.port }),
        ...(edge.enabled !== undefined && { enabled: edge.enabled }),
      });
    }
    return draft;
  } catch {
    return null;
  }
}

export type DraftHistory = { present: ScaleDraft; past: ScaleDraft[]; future: ScaleDraft[] };
export type DraftAction =
  | { type: "change"; draft: ScaleDraft | ((current: ScaleDraft) => ScaleDraft) }
  | { type: "restore"; draft: ScaleDraft }
  | { type: "undo" }
  | { type: "redo" };
export function draftReducer(state: DraftHistory, action: DraftAction): DraftHistory {
  if (action.type === "restore") return { present: action.draft, past: [], future: [] };
  if (action.type === "change") {
    const draft = typeof action.draft === "function" ? action.draft(state.present) : action.draft;
    return JSON.stringify(draft) === JSON.stringify(state.present)
      ? state
      : { present: draft, past: [...state.past.slice(-39), state.present], future: [] };
  }
  if (action.type === "undo" && state.past.length)
    return {
      present: state.past.at(-1)!,
      past: state.past.slice(0, -1),
      future: [state.present, ...state.future],
    };
  if (action.type === "redo" && state.future.length)
    return {
      present: state.future[0],
      past: [...state.past, state.present],
      future: state.future.slice(1),
    };
  return state;
}

export function draftStorageKey(userId: string, organizationId?: string | null): string {
  return `openship:scale:v1:${encodeURIComponent(userId)}:${encodeURIComponent(organizationId ?? "personal")}`;
}
