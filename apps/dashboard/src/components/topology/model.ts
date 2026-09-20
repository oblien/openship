import { isServicesFramework, resolveWorkload } from "@repo/core";
import type { Service, ServiceContainer } from "@/lib/api/services";
import type { ProjectConnection } from "@/lib/api/connections";

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
  deployTarget?: "cloud" | "server" | "local";
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
  | "pending";

export interface TopologyResource {
  id: string;
  kind: "application" | "service" | "edge" | "environment" | "linked" | "instance";
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
  ownerName?: string;
  pending?: boolean;
  isNew?: boolean;
}

export interface TopologyRelation {
  id: string;
  source: string;
  target: string;
  kind: "route" | "dependency" | "binding";
  label: string;
  description: string;
  serviceId?: string;
  dependencyName?: string;
  connection?: ProjectConnection;
  pending?: boolean;
}

export interface ProjectTopologyGraph {
  nodes: TopologyResource[];
  edges: TopologyRelation[];
}

export const applicationNodeId = (projectId: string) => `application:${projectId}`;
export const serviceNodeId = (serviceId: string) => `service:${serviceId}`;
export const environmentNodeId = (projectId: string) => `environment:${projectId}`;

export function hasSeparateApplication(
  project: TopologyProject,
  services: readonly Service[],
): boolean {
  if (isServicesFramework(project.framework)) return false;
  // Adding a companion to a source-built app materializes its main application
  // as a monorepo service. The project header must not mint another copy of it.
  if (services.some((service) => service.kind === "monorepo")) return false;
  // Adopted/cloned stacks deliberately keep framework="unknown"; their stack
  // and runtime identity live on the service rows returned by the same API.
  if (project.framework === "unknown" && project.projectType === "services") return false;
  if (project.isApp && services.length > 0) return false;
  return true;
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
}: {
  project: TopologyProject;
  services: readonly Service[];
  /** null means the host query has not succeeded; it does not mean zero instances. */
  containers: readonly ServiceContainer[] | null;
  connections: readonly ProjectConnection[];
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
      // The release record is not a live container probe.
      state:
        project.enabled === false
          ? "disabled"
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

/** Deterministic first layout; later refreshes preserve the user's positions. */
export function topologyPositions(
  graph: ProjectTopologyGraph,
): Record<string, { x: number; y: number }> {
  const columns = new Map<number, TopologyResource[]>();
  for (const node of graph.nodes) {
    const column =
      node.kind === "edge"
        ? 0
        : node.kind === "linked"
          ? 3
          : node.kind === "environment" || node.tone === "postgres" || node.tone === "redis"
            ? 2
            : 1;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [column, nodes] of columns) {
    for (const [row, node] of nodes.entries()) {
      positions[node.id] = { x: column * 340, y: (row - (nodes.length - 1) / 2) * 200 };
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
