import { AppError } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ExecOnly } from "../../types";
import type { EdgeStatus } from "../types";

/** Routing mesh ports can be occupied without a local task or a LISTEN socket. */
export async function swarmEdgePorts(executor: ExecOnly): Promise<Map<number, string>> {
  try {
    return await readSwarmEdgePorts(executor);
  } catch (error) {
    if (error instanceof AppError) throw error;
    reportCaughtError(error, "adapters/system/proxy/swarm");
    throw new AppError(
      "Could not verify Swarm port ownership. Check access to the Docker daemon, then retry Edge setup.",
      502,
      "SWARM_INSPECTION_UNAVAILABLE",
    );
  }
}

async function readSwarmEdgePorts(executor: ExecOnly): Promise<Map<number, string>> {
  const raw = await executor.exec(
    `if command -v docker >/dev/null 2>&1; then docker info --format '{{json .Swarm}}'; else printf 'null'; fi`,
    { timeout: 10_000 },
  );
  const membership = JSON.parse(raw) as {
    LocalNodeState?: string;
    ControlAvailable?: boolean;
  } | null;
  const ports = new Map<number, string>();
  if (!membership || membership.LocalNodeState === "inactive") return ports;
  if (membership.LocalNodeState !== "active" || !membership.ControlAvailable) {
    // Workers cannot read service specs. Never infer that ingress is free from local
    // sockets alone, or follow a manager address outside the saved server connection.
    return new Map([80, 443].map((port) => [port, "Swarm ingress (inspect through a manager)"]));
  }
  const services = await executor.exec(`docker service ls --format '{{json .}}'`, {
    timeout: 10_000,
  });
  for (const line of services.split("\n").filter((line) => line.trim())) {
    const service = JSON.parse(line) as { Name?: string; Ports?: string };
    if (typeof service.Name !== "string" || typeof service.Ports !== "string")
      throw new AppError(
        "Could not verify Swarm ingress ports. Refresh the server before retrying.",
        409,
        "SWARM_INSPECTION_UNAVAILABLE",
      );
    for (const mapping of service.Ports.split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = mapping.match(/^\*:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/(tcp|udp|sctp)$/);
      if (!match)
        throw new AppError(
          "Could not verify Swarm ingress ports. Refresh the server before retrying.",
          409,
          "SWARM_INSPECTION_UNAVAILABLE",
        );
      if (match[3] !== "tcp") continue;
      const first = Number(match[1]),
        last = Number(match[2] ?? match[1]);
      for (const port of [80, 443])
        if (port >= first && port <= last) ports.set(port, service.Name);
    }
  }
  return ports;
}

export function assertNoSwarmEdge(status: Pick<EdgeStatus, "occupants">): void {
  const occupant = status.occupants.find((item) => item.swarmService);
  if (occupant)
    throw new AppError(
      `Port ${occupant.port} is controlled by ${occupant.swarmService}. Change its published ports through the Swarm manager; Openship cannot take over Swarm ingress.`,
      409,
      "SWARM_SERVICE_OWNED",
    );
}
