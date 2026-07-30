/** Deterministic stack-first view over the adapter's raw manager snapshot. */

import {
  deriveSwarmServiceHealth,
  deriveSwarmStackHealth,
  type SwarmDiscoverySnapshot,
  type SwarmServiceState,
} from "@repo/adapters";

export interface SwarmDiscoveryServiceView {
  id: string;
  name: string;
  sourceServiceName: string;
  mode: SwarmServiceState["mode"];
  image: string | null;
  health: ReturnType<typeof deriveSwarmServiceHealth>;
  taskCount: number;
  nodeIds: string[];
  portainerManaged: boolean;
}

export interface SwarmDiscoveryStackView {
  name: string;
  health: ReturnType<typeof deriveSwarmStackHealth>;
  services: SwarmDiscoveryServiceView[];
  networks: string[];
  volumes: string[];
  configs: string[];
  secrets: string[];
  portainerManaged: boolean;
}

function isControlPlaneService(service: SwarmServiceState): boolean {
  return service.labels["com.openship.control-plane"] === "true" || service.labels["io.openship.control-plane"] === "true";
}

function isPortainerManaged(service: SwarmServiceState): boolean {
  return Object.keys(service.labels).some((key) => key.startsWith("io.portainer."));
}

function uniq(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function serviceView(service: SwarmServiceState, snapshot: SwarmDiscoverySnapshot): SwarmDiscoveryServiceView {
  const tasks = snapshot.tasks.filter((task) => task.serviceId === service.id);
  const eligibleNodeCount = snapshot.nodes.filter(
    (node) => node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
  ).length;
  return {
    id: service.id,
    name: service.name,
    sourceServiceName: service.sourceServiceName,
    mode: service.mode,
    image: service.image,
    health: deriveSwarmServiceHealth(service, tasks, { eligibleNodeCount }),
    taskCount: tasks.length,
    nodeIds: uniq(tasks.flatMap((task) => task.nodeId ? [task.nodeId] : [])),
    portainerManaged: isPortainerManaged(service),
  };
}

/**
 * Stacks are grouped exactly by Docker's namespace label. Services without the
 * label are intentionally surfaced separately instead of being guessed into a
 * stack. Results are bounded by adapter discovery and ordered for stable UI.
 */
export function buildSwarmDiscoveryView(snapshot: SwarmDiscoverySnapshot): {
  stacks: SwarmDiscoveryStackView[];
  standaloneServices: SwarmDiscoveryServiceView[];
  observedAt: string;
  diagnostics: SwarmDiscoverySnapshot["diagnostics"];
} {
  const services = snapshot.services.filter((service) => !isControlPlaneService(service));
  const eligibleNodeCount = snapshot.nodes.filter(
    (node) => node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
  ).length;
  const stacks: SwarmDiscoveryStackView[] = [];
  for (const stack of snapshot.stacks) {
    const stackServices = services.filter((service) => service.stackName === stack.name);
    if (stackServices.length > 0) {
      stacks.push({
        name: stack.name,
        health: deriveSwarmStackHealth({
          stackName: stack.name,
          services: stackServices,
          tasks: snapshot.tasks,
          eligibleNodeCount,
        }),
        services: stackServices.map((service) => serviceView(service, snapshot)).sort((a, b) => a.sourceServiceName.localeCompare(b.sourceServiceName)),
        networks: uniq(stackServices.flatMap((service) => service.networks)),
        // Volume names belong to source/inspect detail. Discovery only has
        // cluster-wide volume metadata, so avoid attributing local volumes here.
        volumes: [],
        configs: uniq(stackServices.flatMap((service) => service.configs)),
        secrets: uniq(stackServices.flatMap((service) => service.secrets)),
        portainerManaged: stackServices.some(isPortainerManaged),
      });
    }
  }
  stacks.sort((a, b) => a.name.localeCompare(b.name));
  return {
    stacks,
    standaloneServices: services
      .filter((service) => service.stackName === null)
      .map((service) => serviceView(service, snapshot))
      .sort((a, b) => a.sourceServiceName.localeCompare(b.sourceServiceName)),
    observedAt: snapshot.observedAt,
    diagnostics: snapshot.diagnostics,
  };
}
