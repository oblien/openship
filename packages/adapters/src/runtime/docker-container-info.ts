import type { ContainerInfo } from "../types";
import type { DockerContainerSummary, DockerPortBinding } from "./types";

function bindingPriority(ip: string | undefined): number {
  const normalized = ip?.trim().replace(/^\[|\]$/g, "") ?? "";
  if (normalized === "127.0.0.1" || normalized === "::1") return 3;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return 2;
  if (normalized && normalized !== "0.0.0.0" && normalized !== "::") return 1;
  return 0;
}

/**
 * Normalize Docker's published-port rows into the runtime's durable mapping.
 *
 * Docker can report several host bindings for one container port. Routes must
 * prefer the loopback binding Openship owns instead of depending on daemon
 * array order. Kept here so list and inspect paths cannot drift.
 */
export function dockerPublishedPortInfo(
  ports: readonly DockerPortBinding[],
): Pick<ContainerInfo, "hostPort" | "hostPortByContainerPort"> {
  const selected = new Map<number, { hostPort: number; priority: number }>();
  for (const binding of ports) {
    if ((binding.type || "tcp").toLowerCase() !== "tcp") continue;
    if (
      !Number.isSafeInteger(binding.privatePort) ||
      binding.privatePort < 1 ||
      binding.privatePort > 65_535
    ) {
      continue;
    }
    const hostPort = binding.publicPort;
    if (
      typeof hostPort !== "number" ||
      !Number.isSafeInteger(hostPort) ||
      hostPort < 1 ||
      hostPort > 65_535
    ) {
      continue;
    }
    const priority = bindingPriority(binding.ip);
    const previous = selected.get(binding.privatePort);
    if (!previous || priority > previous.priority) {
      selected.set(binding.privatePort, { hostPort, priority });
    }
  }

  const hostPortByContainerPort = Object.fromEntries(
    [...selected].map(([containerPort, binding]) => [containerPort, binding.hostPort]),
  );
  const hostPort = selected.values().next().value?.hostPort;
  return {
    ...(hostPort !== undefined ? { hostPort } : {}),
    ...(selected.size > 0 ? { hostPortByContainerPort } : {}),
  };
}

/** Convert a one-shot `docker ps -a` row into the standard runtime view. */
export function containerInfoFromDockerSummary(container: DockerContainerSummary): ContainerInfo {
  const state = container.state.toLowerCase().trim();
  const status: ContainerInfo["status"] =
    state === "running" || state === "restarting"
      ? "running"
      : state === "dead"
        ? "failed"
        : "stopped";
  return {
    containerId: container.id,
    status,
    ...(container.ip ? { ip: container.ip } : {}),
    ...dockerPublishedPortInfo(container.ports),
  };
}
