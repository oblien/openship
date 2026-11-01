import type Dockerode from "dockerode";
import { swarmRequest } from "./api";
import {
  AppError,
  type SwarmInspection,
  type SwarmNodeSummary,
  type SwarmServiceSummary,
} from "@repo/core";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read through the existing authenticated Docker connection, with a cancellable deadline. */
function read(
  docker: Dockerode,
  path: string,
  signal: AbortSignal,
  query?: Record<string, boolean>,
): Promise<unknown> {
  return swarmRequest(docker, "GET", path, { query, signal });
}

function serviceSummary(raw: unknown): SwarmServiceSummary {
  const service = object(raw),
    spec = object(service.Spec);
  const task = object(spec.TaskTemplate),
    container = object(task.ContainerSpec);
  const mode = object(spec.Mode),
    status = object(service.ServiceStatus);
  return {
    id: string(service.ID),
    name: string(spec.Name),
    image: string(container.Image),
    mode: mode.Replicated
      ? "replicated"
      : mode.Global
        ? "global"
        : mode.ReplicatedJob || mode.GlobalJob
          ? "job"
          : "unknown",
    // DesiredTasks is the scheduler's observation (particularly important for global services).
    desiredTasks: count(status.DesiredTasks),
    runningTasks: count(status.RunningTasks),
    updateState: string(object(service.UpdateStatus).State) || null,
    ports: array(object(service.Endpoint).Ports ?? object(spec.EndpointSpec).Ports).flatMap(
      (rawPort) => {
        const port = object(rawPort),
          published = count(port.PublishedPort),
          target = count(port.TargetPort);
        return published && target
          ? [{ published, target, protocol: string(port.Protocol), mode: string(port.PublishMode) }]
          : [];
      },
    ),
    mounts: array(container.Mounts).map((rawMount) => {
      const mount = object(rawMount);
      return {
        type: string(mount.Type),
        target: string(mount.Target),
        readOnly: mount.ReadOnly === true,
      };
    }),
  };
}

/** Observation only. A worker never triggers manager requests, joining, installation or adoption. */
export async function inspectDockerSwarm(
  docker: Dockerode,
  details = false,
): Promise<SwarmInspection> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new AppError(
        "Docker Swarm inspection timed out. Check the server connection and try again.",
        504,
        "SWARM_INSPECTION_TIMEOUT",
      );
      controller.abort(error);
      reject(error);
    }, 15_000);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      timeout,
      (async (): Promise<SwarmInspection> => {
        const info = object(await read(docker, "/info", controller.signal));
        const swarm = object(info.Swarm);
        const rawState = string(swarm.LocalNodeState);
        const state: SwarmInspection["state"] = [
          "inactive",
          "active",
          "pending",
          "locked",
          "error",
        ].includes(rawState)
          ? (rawState as SwarmInspection["state"])
          : "unknown";
        const manager = swarm.ControlAvailable === true;
        const result: SwarmInspection = {
          state,
          role: manager ? "manager" : state === "active" ? "worker" : null,
          nodeId: string(swarm.NodeID) || null,
          // Workers do not necessarily receive a cluster ID from /info. Never invent one from an address.
          clusterId: string(object(swarm.Cluster).ID) || null,
          nodeCount: manager ? count(swarm.Nodes) : null,
          managerCount: manager ? count(swarm.Managers) : null,
          observedAt: new Date().toISOString(),
          inventory: null,
        };
        if (!details || !manager || state !== "active") return result;
        const [services, nodes] = await Promise.all([
          read(docker, "/services", controller.signal, { status: true }),
          read(docker, "/nodes", controller.signal),
        ]);
        if (!Array.isArray(services) || !Array.isArray(nodes))
          throw new AppError(
            "The Swarm manager returned an invalid inventory. Try again.",
            502,
            "SWARM_INSPECTION_INVALID",
          );
        if (services.length > 1000 || nodes.length > 500)
          throw new AppError(
            "This Swarm exceeds the current inspection limit (1,000 services or 500 nodes).",
            422,
            "SWARM_INSPECTION_LIMIT",
          );
        const stacks = new Map<string | null, SwarmServiceSummary[]>();
        for (const service of services) {
          const spec = object(object(service).Spec);
          const stack = string(object(spec.Labels)["com.docker.stack.namespace"]) || null;
          const group = stacks.get(stack) ?? [];
          group.push(serviceSummary(service));
          stacks.set(stack, group);
        }
        result.inventory = {
          nodes: nodes
            .map((raw): SwarmNodeSummary => {
              const node = object(raw),
                spec = object(node.Spec),
                manager = object(node.ManagerStatus);
              return {
                id: string(node.ID),
                name: string(object(node.Description).Hostname),
                role:
                  spec.Role === "manager"
                    ? "manager"
                    : spec.Role === "worker"
                      ? "worker"
                      : "unknown",
                availability: string(spec.Availability),
                state: string(object(node.Status).State),
                leader: manager.Leader === true,
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
          stacks: [...stacks]
            .map(([name, services]) => ({
              name,
              services: services.sort((a, b) => a.name.localeCompare(b.name)),
            }))
            .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
        };
        return result;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
