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
