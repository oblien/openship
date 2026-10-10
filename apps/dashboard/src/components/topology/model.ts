import {
  resolveWorkload,
  type ClusterWorkloadStatus,
  type ClusterWorkloadConfig,
  type ClusterVolume,
} from "@repo/core";
import type { Service, ServiceContainer } from "@/lib/api/services";
import type { ProjectConnection } from "@/lib/api/connections";
import type { ClusterDatabase } from "@repo/contracts";
import { hasSeparateApplication } from "@/lib/project-application";
export { hasSeparateApplication } from "@/lib/project-application";

/** A projection of saved project data. Canvas positions never define infrastructure. */
export interface TopologyProject {
  id: string;
  name: string;
  framework: string;
  projectType?: "app" | "services" | "monorepo";
  environmentName?: string;
  environmentType?: string;
  activeDeploymentId?: string | null;
  activeVersion?: number | null;
  activeDeploymentStatus?: string | null;
  latestDeploymentStatus?: string | null;
  enabled?: boolean | null;
  deployTarget?: "cloud" | "server" | "local" | "cluster";
  clusterId?: string | null;
  clusterConfig?: ClusterWorkloadConfig | null;
  serverName?: string | null;
  serverId?: string | null;
  isApp?: boolean;
  appTemplateId?: string | null;
  options?: { hasServer?: boolean; workloadType?: string; [key: string]: unknown };
  access?: { host: string | null; url: string | null; urls?: string[] };
  domains?: Array<{ domain: string; serviceId?: string | null; [key: string]: unknown }>;
}

export type TopologyTone = "edge" | "service" | "postgres" | "redis";
export type TopologyState =
  | "running"
  | "starting"
  | "restarting"
  | "stopped"
  | "failed"
  | "unknown"
  | "disabled"
  | "configured"
  | "pending"
  | "succeeded"
  | "cancelled"
  | "skipped";

export interface TopologyResource {
  id: string;
  kind:
    | "application"
    | "service"
    | "edge"
    | "environment"
    | "linked"
    | "instance"
    | "traffic"
    | "database"
    | "volume"
    | "workflow-job"
    | "workflow-step";
  name: string;
  description: string;
  tone: TopologyTone;
  state: TopologyState;
  projectId: string;
  serviceId?: string;
  service?: Service;
  container?: ServiceContainer;
  image?: string | null;
  version?: string;
  /** Only a runtime observation may supply the number of running instances. */
  instances?: number;
  replicaStatus?: ClusterWorkloadStatus;
  clusterPod?: ClusterWorkloadStatus["pods"][number];
  database?: ClusterDatabase;
  volume?: ClusterVolume;
  ownerName?: string;
  pending?: boolean;
  isNew?: boolean;
  /** Optional dependency depth for non-infrastructure graphs. */
  layoutColumn?: number;
  /** Expanded node content reserves its actual size in the shared layout. */
  layoutHeight?: number;
  layoutWidth?: number;
  /** Child nodes move with their parent and use parent-relative positions. */
  parentId?: string;
  layoutPosition?: { x: number; y: number };
  workflowStep?: { jobId: string; index: number; kind: "action" | "command" };
}

export interface TopologyRelation {
  id: string;
  source: string;
  target: string;
  kind: "route" | "dependency" | "binding" | "sequence";
  sourceHandle?: string;
  targetHandle?: string;
  readOnly?: boolean;
  /** A runtime service route is not an editable public domain. */
  scope?: "instances" | "database" | "storage";
  databaseId?: string;
  volumeName?: string;
  label: string;
  description: string;
  serviceId?: string;
  dependencyName?: string;
  connection?: ProjectConnection;
  pending?: boolean;
  enabled?: boolean;
}

export interface ProjectTopologyGraph {
  nodes: TopologyResource[];
  edges: TopologyRelation[];
}

export const applicationNodeId = (projectId: string) => `application:${projectId}`;
export const serviceNodeId = (serviceId: string) => `service:${serviceId}`;
export const environmentNodeId = (projectId: string) => `environment:${projectId}`;
export const databaseNodeId = (id: string) => `database:${id}`;
export const volumeNodeId = (name: string) => `volume:${name}`;

export function addClusterVolumes(
  graph: ProjectTopologyGraph,
  project: TopologyProject,
  volumes: readonly ClusterVolume[],
): ProjectTopologyGraph {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  for (const volume of volumes) {
    nodes.push({
      id: volumeNodeId(volume.name),
      kind: "volume",
      name: volume.name,
      description: `Shared files · ${volume.sizeGiB} GiB`,
      projectId: project.id,
      tone: "service",
      volume,
      state:
        volume.robustness === "faulted" || volume.phase === "Lost"
          ? "failed"
          : volume.phase === "Deleting"
            ? "stopped"
            : volume.phase !== "Bound" || volume.robustness !== "healthy"
              ? "starting"
              : "running",
    });
    const mount = project.clusterConfig?.mounts?.find((mount) => mount.name === volume.name);
    if (mount && nodes.some((node) => node.id === applicationNodeId(project.id)))
      edges.push({
        id: `volume-connection:${volume.name}`,
        source: applicationNodeId(project.id),
        target: volumeNodeId(volume.name),
        kind: "binding",
        scope: "storage",
        volumeName: volume.name,
        label: mount.mountPath,
        description: `${mount.readOnly ? "Read-only files" : "Shared files"} at ${mount.mountPath}. Deploy the application after changing this connection.`,
      });
  }
  return { nodes, edges };
}

export function addClusterDatabases(
  graph: ProjectTopologyGraph,
  project: TopologyProject,
  databases: readonly ClusterDatabase[],
): ProjectTopologyGraph {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  for (const database of databases) {
    if (database.status === "deleted" || database.projectId !== project.id) continue;
    const state: TopologyState =
      database.status === "ready"
        ? database.observation?.ready
          ? "running"
          : "failed"
        : ["failed", "interrupted"].includes(database.status)
          ? "failed"
          : database.status === "retained"
            ? "stopped"
            : "starting";
    nodes.push({
      id: databaseNodeId(database.id),
      kind: "database",
      name: database.name,
      projectId: project.id,
      tone: database.config.engine,
      description: `${database.config.engine === "postgres" ? "PostgreSQL" : "Redis"} · ${database.config.mode === "cluster" ? "Cluster" : "Standalone"}`,
      state,
      database,
      instances: database.observation?.pods.length,
    });
    if (database.envKey && nodes.some((node) => node.id === applicationNodeId(project.id)))
      edges.push({
        id: `database-connection:${database.id}`,
        source: applicationNodeId(project.id),
        target: databaseNodeId(database.id),
        kind: "binding",
        scope: "database",
        databaseId: database.id,
        label: database.envKey,
        description: `${database.envKey} connects this application to the database over its private network. Redeploy the application after changing the connection.`,
      });
  }
  return { nodes, edges };
}

export function buildDatabaseReplicaTopology(
  project: TopologyProject,
  database: ClusterDatabase,
): ProjectTopologyGraph {
  const pods = database.observation?.pods ?? [];
  const nodes: TopologyResource[] = pods.map((pod) => ({
    id: `database-pod:${database.id}:${pod.name}`,
    kind: "instance",
    projectId: project.id,
    name: pod.role === "primary" ? "Primary" : pod.role === "replica" ? "Replica" : pod.name,
    description: pod.serverName ?? "Assigning a server",
    state: pod.ready ? "running" : pod.phase === "Failed" ? "failed" : "starting",
    tone: database.config.engine,
    clusterPod: pod,
  }));
  // PostgreSQL reports the actual primary. Redis roles can change independently
  // of StatefulSet names; do not invent a replication graph from pod ordinals.
  const primary = database.observation?.primary;
  const edges: TopologyRelation[] = primary
    ? pods
        .filter((pod) => pod.name !== primary)
        .map((pod) => ({
          id: `replication:${database.id}:${pod.name}`,
          source: `database-pod:${database.id}:${primary}`,
          target: `database-pod:${database.id}:${pod.name}`,
          kind: "route",
          scope: "instances",
          label: "Replication",
          description: "PostgreSQL streaming replication managed by the database operator.",
        }))
    : [];
  return { nodes, edges };
}

export function clusterInstances(status: ClusterWorkloadStatus) {
  return [...status.pods]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pod, index) => ({
      pod,
      name: `Instance ${index + 1}`,
      server:
        pod.serverName ?? (pod.nodeName ? "Server details unavailable" : "Assigning a server"),
      state: (pod.ready
        ? "running"
        : /BackOff|Error|Failed/.test(pod.phase)
          ? "failed"
          : pod.phase === "Succeeded"
            ? "stopped"
            : pod.phase === "Unknown"
              ? "unknown"
              : "starting") as TopologyState,
    }));
}

export function buildClusterReplicaTopology(
  project: TopologyProject,
  status: ClusterWorkloadStatus,
): ProjectTopologyGraph {
  const nodes: TopologyResource[] = clusterInstances(status).map(
    ({ pod, name, server, state }) => ({
      id: `pod:${pod.name}`,
      kind: "instance",
      projectId: project.id,
      name,
      description: server,
      tone: "service",
      clusterPod: pod,
      state,
    }),
  );
  const edges: TopologyRelation[] = [];
  if (resolveWorkload(project.options?.workloadType, project.options?.hasServer) === "web") {
    const id = `cluster-service:${project.id}`;
    for (const node of nodes)
      edges.push({
        id: `${id}:${node.id}`,
        source: id,
        target: node.id,
        kind: "route",
        scope: "instances",
        label: node.clusterPod?.ready ? "Serving" : "Not ready",
        description: "Traffic goes to healthy instances automatically.",
        enabled: node.clusterPod?.ready,
      });
    nodes.unshift({
      id,
      kind: "traffic",
      name: "Traffic distribution",
      description: "Routes to healthy instances",
      projectId: project.id,
      tone: "service",
      state: status.ready > 0 ? "running" : status.desired === 0 ? "stopped" : "starting",
    });
  }
  return { nodes, edges };
}

/** Presentation only: recognizing a logo never grants replication capabilities. */
export function servicePresentation(service: Pick<Service, "image" | "kind" | "build">): {
  tone: TopologyTone;
  label: string;
} {
  const image = service.image?.split("@")[0]?.split("/").pop()?.split(":")[0]?.toLowerCase() ?? "";
  if (["postgres", "postgresql", "pgvector", "timescaledb"].includes(image)) {
    return { tone: "postgres", label: "PostgreSQL" };
  }
  if (["redis", "valkey", "keydb", "dragonfly"].includes(image)) {
    return {
      tone: "redis",
      label: image === "redis" ? "Redis" : image === "valkey" ? "Valkey" : "Cache",
    };
  }
  if (
    [
      "mysql",
      "mariadb",
      "mongo",
      "mongodb",
      "clickhouse",
      "clickhouse-server",
      "cockroach",
    ].includes(image)
  ) {
    return { tone: "postgres", label: "Database" };
  }
  return {
    tone: "service",
    label: service.kind === "monorepo" || service.build ? "Application" : "Service",
  };
}

function containerState(
  container: ServiceContainer | undefined,
  service: Service,
  deployed: boolean,
): TopologyState {
  if (
    container &&
    ["running", "starting", "restarting", "stopped", "failed", "unknown"].includes(container.status)
  ) {
    return container.status as TopologyState;
  }
  if (!service.enabled) return "disabled";
  return deployed ? "unknown" : "configured";
}

export function buildProjectTopology({
  project,
  services,
  containers,
  connections,
  cluster,
}: {
  project: TopologyProject;
  services: readonly Service[];
  /** null means the host query has not succeeded; it does not mean zero instances. */
  containers: readonly ServiceContainer[] | null;
  connections: readonly ProjectConnection[];
  cluster?: ClusterWorkloadStatus | null;
}): ProjectTopologyGraph {
  const nodes: TopologyResource[] = [];
  const edges: TopologyRelation[] = [];
  const serviceByName = new Map(services.map((service) => [service.name, service]));
  const liveById = new Map(containers?.map((container) => [container.serviceId, container]));
  const hasPrimaryApplication = hasSeparateApplication(project, services);
  const version = project.activeVersion != null ? `v${project.activeVersion}` : undefined;

  if (hasPrimaryApplication) {
    nodes.push({
      id: applicationNodeId(project.id),
      kind: "application",
      projectId: project.id,
      name: project.name,
      description:
        resolveWorkload(project.options?.workloadType, project.options?.hasServer) === "static"
          ? "Static application"
          : project.options?.workloadType === "worker"
            ? "Worker"
            : "Application",
      tone: "service",
      version,
      ...(cluster ? { replicaStatus: cluster, instances: cluster.ready } : {}),
      // The release record is not a live container probe.
      state:
        project.enabled === false
          ? "disabled"
          : cluster
            ? cluster.desired === 0
              ? "stopped"
              : cluster.available >= cluster.desired &&
                  cluster.observedGeneration >= cluster.generation
                ? "running"
                : "starting"
            : project.activeDeploymentId
              ? "unknown"
              : "configured",
    });
  }

  for (const service of services) {
    const container = liveById.get(service.id);
    const presentation = servicePresentation(service);
    const state = containerState(container, service, !!project.activeDeploymentId);
    nodes.push({
      id: serviceNodeId(service.id),
      kind: "service",
      projectId: project.id,
      serviceId: service.id,
      name: service.name,
      description: presentation.label,
      tone: presentation.tone,
      state,
      service,
      container,
      image: container?.imageRef ?? service.image,
      // A service may have been carried from an older release. Its observed image
      // is authoritative; the project's latest version is not its image version.
      instances:
        container && state !== "unknown"
          ? container.containerId && state === "running"
            ? 1
            : 0
          : undefined,
    });
    for (const dependencyName of service.dependsOn ?? []) {
      const dependency = serviceByName.get(dependencyName);
      if (!dependency) continue;
      edges.push({
        id: `dependency:${service.id}:${dependency.id}`,
        source: serviceNodeId(service.id),
        target: serviceNodeId(dependency.id),
        kind: "dependency",
        label: "Starts after",
        serviceId: service.id,
        dependencyName,
        description: `${service.name} starts after ${dependency.name}. Connection credentials are configured separately.`,
      });
    }
  }

  // Show public routing only where the stored configuration actually declares it.
  const routed = services.filter((service) => service.exposed);
  const mainDomains = (project.domains ?? []).filter((domain) => !domain.serviceId);
  const mainIsPublic =
    hasPrimaryApplication && (mainDomains.length > 0 || (!routed.length && !!project.access?.host));
  if (routed.length || mainIsPublic) {
    const edgeId = `edge:${project.id}`;
    nodes.unshift({
      id: edgeId,
      kind: "edge",
      projectId: project.id,
      name: "OpenShip Edge",
      tone: "edge",
      state: "configured",
      description: "Public routing",
    });
    for (const service of routed) {
      edges.push({
        id: `route:${service.id}`,
        source: edgeId,
        target: serviceNodeId(service.id),
        kind: "route",
        label: service.customDomain || service.domain || "Public route",
        serviceId: service.id,
        description: `Public routing for ${service.name}${service.exposedPort ? ` on port ${service.exposedPort}` : ""}.`,
      });
    }
    if (mainIsPublic)
      edges.push({
        id: `route:${project.id}`,
        source: edgeId,
        target: applicationNodeId(project.id),
        kind: "route",
        label: mainDomains[0]?.domain || project.access?.host || "Public route",
        description: "Public routing for this application.",
      });
  }

  // A project connection injects an ENVIRONMENT-scoped variable. Drawing it to
  // every API (or the selected API) would invent per-service network semantics.
  const ownedConnections = connections.filter(
    (connection) => connection.targetProjectId === project.id,
  );
  if (ownedConnections.length) {
    const environmentId = environmentNodeId(project.id);
    nodes.push({
      id: environmentId,
      kind: "environment",
      projectId: project.id,
      name: project.environmentName || project.environmentType || "Environment",
      description: "Shared environment bindings",
      tone: "service",
      state: "configured",
    });
    const linkedIds = new Set<string>();
    for (const connection of ownedConnections) {
      const linkedId = `linked:${connection.sourceProjectId}:${connection.sourceServiceId ?? "app"}`;
      if (!linkedIds.has(linkedId)) {
        linkedIds.add(linkedId);
        nodes.push({
          id: linkedId,
          kind: "linked",
          projectId: connection.sourceProjectId,
          serviceId: connection.sourceServiceId ?? undefined,
          name: connection.sourceServiceName || connection.sourceName,
          ownerName: connection.sourceName,
          description: "Linked service",
          tone: servicePresentation({ image: connection.sourceAppTemplateId, build: null }).tone,
          state: "unknown",
        });
      }
      edges.push({
        id: `binding:${connection.id}`,
        source: environmentId,
        target: linkedId,
        kind: "binding",
        label: connection.envKey,
        description: `${connection.envKey} is provided to the whole environment over ${connection.mode === "internal" ? "the private network" : "a public endpoint"}.`,
        connection,
      });
    }
  }
  return { nodes, edges };
}

export interface TopologyNodeLayout {
  width: number;
  height: number;
  gapX: number;
  gapY: number;
}

export const DEFAULT_TOPOLOGY_NODE_LAYOUT: TopologyNodeLayout = {
  width: 250,
  height: 160,
  gapX: 90,
  gapY: 40,
};

/** Deterministic first layout; later refreshes preserve the user's positions. */
export function topologyPositions(
  graph: ProjectTopologyGraph,
  layout = DEFAULT_TOPOLOGY_NODE_LAYOUT,
): Record<string, { x: number; y: number }> {
  const columns = new Map<number, TopologyResource[]>();
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of graph.nodes) {
    if (node.parentId) {
      positions[node.id] = node.layoutPosition ?? { x: 0, y: 0 };
      continue;
    }
    const column =
      node.layoutColumn ??
      (node.kind === "edge" || node.kind === "traffic"
        ? 0
        : node.kind === "linked"
          ? 3
          : node.kind === "environment" || node.tone === "postgres" || node.tone === "redis"
            ? 2
            : 1);
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const widths = new Map(
    [...columns].map(([column, nodes]) => [
      column,
      Math.max(layout.width, ...nodes.map((node) => node.layoutWidth ?? layout.width)),
    ]),
  );
  for (const [column, nodes] of columns) {
    const totalHeight =
      nodes.reduce((height, node) => height + (node.layoutHeight ?? layout.height), 0) +
      Math.max(0, nodes.length - 1) * layout.gapY;
    const x =
      column * (layout.width + layout.gapX) +
      [...widths]
        .filter(([other]) => other < column)
        .reduce((extra, [, width]) => extra + width - layout.width, 0);
    let y = (layout.height - totalHeight) / 2;
    for (const node of nodes) {
      positions[node.id] = { x, y };
      y += (node.layoutHeight ?? layout.height) + layout.gapY;
    }
  }
  return positions;
}

export function dependencyProblem(
  services: readonly Service[],
  sourceId: string,
  targetId: string,
): string | null {
  const source = services.find((service) => service.id === sourceId);
  const target = services.find((service) => service.id === targetId);
  if (!source || !target) return "Choose two services in this environment.";
  if (source.id === target.id) return "A service cannot depend on itself.";
  if (source.dependsOn?.includes(target.name)) return "This dependency already exists.";
  const byName = new Map(services.map((service) => [service.name, service]));
  const seen = new Set<string>();
  const reaches = (name: string): boolean => {
    if (name === source.name) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (byName.get(name)?.dependsOn ?? []).some(reaches);
  };
  return reaches(target.name) ? "This would create a circular startup dependency." : null;
}
