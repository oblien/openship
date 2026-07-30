import type {
  SwarmNamedObjectState,
  SwarmNetworkState,
  SwarmNodeState,
  SwarmPublishedPort,
  SwarmServiceMode,
  SwarmServiceState,
  SwarmStackState,
  SwarmTaskState,
  SwarmVolumeState,
} from "./types";
import type { SwarmManagerInfo } from "./types";

export class SwarmProbeError extends Error {
  constructor(
    readonly code: import("./types").SwarmProbeFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SwarmProbeError";
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function labels(value: unknown): Record<string, string> {
  const input = asRecord(value);
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, label]) => (typeof label === "string" ? [[key, label]] : [])),
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []))
    : [];
}

function referenceNames(value: unknown, key: "ConfigName" | "SecretName"): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = text(asRecord(entry)?.[key]);
    return name ? [name] : [];
  });
}

function environmentKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const key = entry.split("=", 1)[0]?.trim() ?? "";
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? [key] : [];
  }))).sort();
}

function healthcheck(value: unknown): SwarmServiceState["healthcheck"] | undefined {
  const input = asRecord(value);
  if (!input) return undefined;
  const integerValue = integer(input.Retries);
  return {
    configured: true,
    ...(input.Test === "NONE" ? { disabled: true } : {}),
    ...(text(input.Interval) ? { interval: text(input.Interval)! } : {}),
    ...(text(input.Timeout) ? { timeout: text(input.Timeout)! } : {}),
    ...(integerValue !== null ? { retries: integerValue } : {}),
    ...(text(input.StartPeriod) ? { startPeriod: text(input.StartPeriod)! } : {}),
  };
}

function serviceMode(mode: unknown): SwarmServiceMode {
  const input = asRecord(mode);
  if (!input) return "unknown";
  if (input.Replicated) return "replicated";
  if (input.Global) return "global";
  if (input.ReplicatedJob) return "replicated-job";
  if (input.GlobalJob) return "global-job";
  return "unknown";
}

function publishedPorts(value: unknown): SwarmPublishedPort[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const port = asRecord(entry);
    const target = integer(port?.TargetPort);
    if (target === null) return [];
    return [{
      target,
      published: integer(port?.PublishedPort),
      protocol: text(port?.Protocol) ?? "tcp",
      mode: text(port?.PublishMode) ?? "ingress",
    }];
  });
}

/** Normalize Docker's `docker info --format '{{json .}}'` without accepting a worker. */
export function normalizeSwarmManagerInfo(
  dockerInfo: unknown,
  dockerServer?: unknown,
): SwarmManagerInfo {
  const info = asRecord(dockerInfo);
  const swarm = asRecord(info?.Swarm);
  if (!info || !swarm) {
    throw new SwarmProbeError(
      "SWARM_INVALID_INFO",
      "Docker returned an invalid info response while probing Docker Swarm.",
    );
  }

  const localNodeState = text(swarm.LocalNodeState)?.toLowerCase();
  if (localNodeState !== "active") {
    throw new SwarmProbeError(
      "SWARM_INACTIVE",
      "Docker Swarm is inactive on this target. Connect OpenShip to an active Swarm manager.",
    );
  }
  if (swarm.ControlAvailable !== true) {
    throw new SwarmProbeError(
      "SWARM_MANAGER_REQUIRED",
      "This Docker node is a Swarm worker. Connect OpenShip to a Swarm manager instead.",
    );
  }

  const cluster = asRecord(swarm.Cluster);
  const clusterId = text(cluster?.ID);
  const nodeId = text(swarm.NodeID);
  if (!clusterId || !nodeId) {
    throw new SwarmProbeError(
      "SWARM_INVALID_INFO",
      "The Swarm manager did not report a stable cluster or node identity.",
    );
  }

  const server = asRecord(dockerServer);
  const remoteManagers = Array.isArray(swarm.RemoteManagers) ? swarm.RemoteManagers : [];
  const managerAddress = text(asRecord(remoteManagers[0])?.Addr);
  return {
    engineVersion: text(server?.Version) ?? text(info.ServerVersion),
    apiVersion: text(server?.APIVersion) ?? text(info.ServerAPIVersion),
    localNodeState: "active",
    controlAvailable: true,
    clusterId,
    nodeId,
    nodeAddress: text(swarm.NodeAddr),
    managerAddress,
  };
}

export function normalizeSwarmNode(value: unknown): SwarmNodeState {
  const node = asRecord(value);
  const status = asRecord(node?.Status);
  const spec = asRecord(node?.Spec);
  const description = asRecord(node?.Description);
  const engine = asRecord(description?.Engine);
  const manager = asRecord(node?.ManagerStatus);
  return {
    id: text(node?.ID) ?? "",
    hostname: text(description?.Hostname) ?? text(node?.Hostname) ?? "",
    status: text(status?.State) ?? text(node?.Status) ?? "unknown",
    availability: text(spec?.Availability) ?? text(node?.Availability) ?? "active",
    managerStatus: text(manager?.Leader) === "true" ? "Leader" : text(node?.ManagerStatus),
    engineVersion: text(engine?.EngineVersion) ?? text(node?.EngineVersion),
    labels: labels(spec?.Labels ?? node?.Labels),
  };
}

/** Normalize full `docker service inspect` data without flattening the source spec. */
export function normalizeSwarmService(value: unknown): SwarmServiceState {
  const service = asRecord(value);
  const spec = asRecord(service?.Spec);
  const task = asRecord(spec?.TaskTemplate);
  const container = asRecord(task?.ContainerSpec);
  const endpoint = asRecord(spec?.EndpointSpec);
  const update = asRecord(service?.UpdateStatus);
  const serviceLabels = labels(spec?.Labels);
  const stackName = serviceLabels["com.docker.stack.namespace"] ?? null;
  const name = text(spec?.Name) ?? text(service?.ID) ?? "";
  const sourceServiceName = stackName && name.startsWith(`${stackName}_`)
    ? name.slice(stackName.length + 1)
    : name;
  const mode = asRecord(spec?.Mode);
  const replicated = asRecord(mode?.Replicated);
  const networks = Array.isArray(task?.Networks)
    ? task.Networks.flatMap((network) => {
        const n = asRecord(network);
        const target = text(n?.Target) ?? stringList(n?.Aliases)[0] ?? null;
        return target ? [target] : [];
      })
    : [];
  return {
    id: text(service?.ID) ?? "",
    name,
    sourceServiceName,
    stackName,
    specVersion: integer(asRecord(service?.Version)?.Index),
    mode: serviceMode(spec?.Mode),
    desiredReplicas: integer(replicated?.Replicas),
    image: text(container?.Image),
    ...(environmentKeys(container?.Env).length ? { environmentKeys: environmentKeys(container?.Env) } : {}),
    ...(healthcheck(container?.Healthcheck) ? { healthcheck: healthcheck(container?.Healthcheck) } : {}),
    labels: serviceLabels,
    endpointMode: text(endpoint?.Mode),
    placement: asRecord(task?.Placement),
    resources: asRecord(task?.Resources),
    updateConfig: asRecord(spec?.UpdateConfig),
    rollbackConfig: asRecord(spec?.RollbackConfig),
    restartPolicy: asRecord(task?.RestartPolicy),
    networks,
    configs: referenceNames(container?.Configs, "ConfigName"),
    secrets: referenceNames(container?.Secrets, "SecretName"),
    publishedPorts: publishedPorts(asRecord(service?.Endpoint)?.Ports ?? endpoint?.Ports),
    updateState: text(update?.State),
    updateMessage: text(update?.Message),
  };
}

/** Normalize `docker service ps --format '{{json .}}'` rows; historical rows stay visible for health selection. */
export function normalizeSwarmTask(
  value: unknown,
  service: Pick<SwarmServiceState, "id" | "name">,
  observedAt: string,
): SwarmTaskState {
  const task = asRecord(value);
  const taskName = text(task?.Name) ?? "";
  const slotText = taskName.match(/\.(\d+)(?:\.|$)/)?.[1] ?? null;
  return {
    id: text(task?.ID) ?? "",
    serviceId: service.id,
    serviceName: service.name,
    slot: slotText ? Number(slotText) : null,
    nodeId: text(task?.NodeID),
    nodeName: text(task?.Node),
    desiredState: text(task?.DesiredState) ?? "unknown",
    currentState: text(task?.CurrentState) ?? "unknown",
    error: text(task?.Error),
    image: text(task?.Image),
    updatedAt: text(task?.UpdatedAt),
    observedAt,
  };
}

export function groupSwarmStacks(services: SwarmServiceState[]): SwarmStackState[] {
  const stacks = new Map<string, SwarmStackState>();
  for (const service of services) {
    if (!service.stackName) continue;
    const stack = stacks.get(service.stackName) ?? {
      name: service.stackName,
      serviceIds: [],
      serviceNames: [],
    };
    stack.serviceIds.push(service.id);
    stack.serviceNames.push(service.sourceServiceName);
    stacks.set(service.stackName, stack);
  }
  return Array.from(stacks.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeSwarmNetwork(value: unknown): SwarmNetworkState {
  const network = asRecord(value);
  return {
    id: text(network?.ID) ?? "",
    name: text(network?.Name) ?? "",
    driver: text(network?.Driver),
    scope: text(network?.Scope),
    labels: labels(network?.Labels),
  };
}

export function normalizeSwarmVolume(value: unknown): SwarmVolumeState {
  const volume = asRecord(value);
  const options = asRecord(volume?.Options);
  return {
    name: text(volume?.Name) ?? "",
    driver: text(volume?.Driver),
    scope: text(volume?.Scope),
    labels: labels(volume?.Labels),
    options: labels(options),
  };
}

/** Configs and secrets use the same metadata-only list shape. */
export function normalizeSwarmNamedObject(value: unknown): SwarmNamedObjectState {
  const object = asRecord(value);
  return {
    id: text(object?.ID) ?? "",
    name: text(object?.Name) ?? "",
    labels: labels(object?.Labels),
    createdAt: text(object?.CreatedAt),
  };
}
