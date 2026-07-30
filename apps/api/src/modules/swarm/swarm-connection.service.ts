/**
 * Project-scoped Swarm manager binding health and manual rebinding.
 *
 * This intentionally does not implement automatic failover. A user selects an
 * existing OpenShip server target, the service proves it is an active manager
 * for the already-bound cluster, and only then persists the new target.
 */

import { AppError, NotFoundError } from "@repo/core";
import type { Platform, SwarmManagerInfo } from "@repo/adapters";
import { repos, type SwarmStack } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";

type SwarmPlatform = Pick<Platform, "stackRuntime">;
type SafeServer = {
  id: string;
  name: string | null;
  sshHost: string;
  sshPort: number | null;
  isLocal: boolean;
};

interface Dependencies {
  featureEnabled: () => boolean;
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  getServer: (serverId: string, organizationId: string) => Promise<SafeServer | undefined>;
  listServers: (organizationId: string) => Promise<SafeServer[]>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  updateStack: (
    id: string,
    organizationId: string,
    patch: { managerServerId: string },
  ) => Promise<SwarmStack | undefined>;
}

function endpoint(server: SafeServer): string {
  return server.isLocal ? "This OpenShip host" : server.sshHost + ":" + (server.sshPort ?? 22);
}

function lastError(stack: SwarmStack): string | null {
  const details = stack.driftDetails;
  if (!details || typeof details !== "object") return null;
  const connection = (details as Record<string, unknown>).connection;
  if (connection && typeof connection === "object") {
    const error = (connection as Record<string, unknown>).lastError;
    if (typeof error === "string" && error.trim()) return error;
  }
  const summary = (details as Record<string, unknown>).summary;
  return stack.driftStatus === "unreachable" && typeof summary === "string" ? summary : null;
}

function stableError(error: unknown): { state: "unreachable" | "manager-required"; message: string } {
  if (error instanceof AppError) {
    return {
      state: error.code === "SWARM_MANAGER_REQUIRED" ? "manager-required" : "unreachable",
      message: error.message,
    };
  }
  return {
    state: "unreachable",
    message: "OpenShip could not reach this Swarm manager. Verify the server connection and Docker permissions.",
  };
}

function probeResult(info: SwarmManagerInfo, stack: SwarmStack, server: SafeServer, nodes: Array<{
  id: string;
  hostname: string;
  status: string;
  availability: string;
  managerStatus: string | null;
  engineVersion: string | null;
  labels: Record<string, string>;
}>) {
  const sameCluster = info.clusterId === stack.clusterId;
  return {
    server: {
      id: server.id,
      name: server.name,
      endpoint: endpoint(server),
      isLocal: server.isLocal,
    },
    health: sameCluster ? "healthy" as const : "wrong-cluster" as const,
    managerState: "active-manager" as const,
    controlAvailable: true,
    clusterId: info.clusterId,
    nodeId: info.nodeId,
    nodeAddress: info.nodeAddress,
    managerAddress: info.managerAddress,
    lastSuccessfulProbeAt: stack.lastObservedAt?.toISOString() ?? null,
    lastError: sameCluster ? null : "This manager reports a different Swarm cluster than the project binding.",
    nodes,
  };
}

export function createSwarmConnectionService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    featureEnabled: swarmSupportEnabled,
    getStack: (projectId, organizationId) =>
      repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    getServer: (serverId, organizationId) => repos.server.getInOrganization(serverId, organizationId),
    listServers: (organizationId) => repos.server.listByOrganization(organizationId),
    resolvePlatform: async (serverId, organizationId) =>
      resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    updateStack: (id, organizationId, patch) =>
      repos.swarmStack.updateInOrganization(id, organizationId, patch),
    ...overrides,
  };

  function assertEnabled() {
    if (!deps.featureEnabled()) {
      throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
    }
  }

  async function stackFor(projectId: string, organizationId: string) {
    assertEnabled();
    const stack = await deps.getStack(projectId, organizationId);
    if (!stack) throw new NotFoundError("Swarm stack for project", projectId);
    return stack;
  }

  async function managerFor(serverId: string, organizationId: string) {
    const server = await deps.getServer(serverId, organizationId);
    if (!server) throw new NotFoundError("Server", serverId);
    const platform = await deps.resolvePlatform(server.id, organizationId);
    if (!platform.stackRuntime) {
      throw new AppError("This target does not provide Docker Swarm manager access.", 409, "SWARM_MANAGER_REQUIRED");
    }
    return { server, runtime: platform.stackRuntime };
  }

  return {
    async status(projectId: string, organizationId: string) {
      const stack = await stackFor(projectId, organizationId);
      const candidates = (await deps.listServers(organizationId)).map((server) => ({
        id: server.id,
        name: server.name,
        endpoint: endpoint(server),
        isCurrent: server.id === stack.managerServerId,
      }));
      if (!stack.managerServerId) {
        return {
          expectedClusterId: stack.clusterId,
          manager: {
            server: null,
            health: "missing" as const,
            managerState: "missing" as const,
            controlAvailable: null,
            clusterId: null,
            nodeId: null,
            nodeAddress: null,
            managerAddress: null,
            lastSuccessfulProbeAt: stack.lastObservedAt?.toISOString() ?? null,
            lastError: "The configured OpenShip manager target no longer exists.",
            nodes: [],
          },
          candidates,
        };
      }
      try {
        const { server, runtime } = await managerFor(stack.managerServerId, organizationId);
        const manager = await runtime.probe();
        let nodes: Awaited<ReturnType<typeof runtime.discover>>["nodes"] = [];
        try {
          nodes = (await runtime.discover()).nodes;
        } catch {
          // A successful probe is still useful if the heavier inventory read
          // times out. Keep this a read-only status response rather than
          // treating node inventory as a binding mutation prerequisite.
        }
        return {
          expectedClusterId: stack.clusterId,
          manager: probeResult(manager, stack, server, nodes),
          candidates,
        };
      } catch (error) {
        const failure = stableError(error);
        const configured = await deps.getServer(stack.managerServerId, organizationId);
        return {
          expectedClusterId: stack.clusterId,
          manager: {
            server: configured
              ? { id: configured.id, name: configured.name, endpoint: endpoint(configured), isLocal: configured.isLocal }
              : null,
            health: "unreachable" as const,
            managerState: failure.state,
            controlAvailable: false,
            clusterId: null,
            nodeId: null,
            nodeAddress: null,
            managerAddress: null,
            lastSuccessfulProbeAt: stack.lastObservedAt?.toISOString() ?? null,
            lastError: failure.message || lastError(stack),
            nodes: [],
          },
          candidates,
        };
      }
    },

    async rebind(input: { projectId: string; organizationId: string; serverId: string }) {
      const stack = await stackFor(input.projectId, input.organizationId);
      if (stack.managerServerId === input.serverId) {
        throw new AppError("This project is already bound to the selected Swarm manager.", 409, "SWARM_MANAGER_ALREADY_BOUND");
      }
      const { server, runtime } = await managerFor(input.serverId, input.organizationId);
      let manager: SwarmManagerInfo;
      try {
        manager = await runtime.probe();
      } catch (error) {
        const failure = stableError(error);
        throw new AppError(failure.message, 409, failure.state === "manager-required" ? "SWARM_MANAGER_REQUIRED" : "SWARM_MANAGER_UNAVAILABLE");
      }
      if (manager.clusterId !== stack.clusterId) {
        throw new AppError(
          "The selected manager belongs to a different Swarm cluster than this project.",
          409,
          "SWARM_CLUSTER_MISMATCH",
        );
      }
      const updated = await deps.updateStack(stack.id, input.organizationId, { managerServerId: server.id });
      if (!updated) throw new NotFoundError("Swarm stack", stack.id);
      return {
        managerServerId: updated.managerServerId,
        clusterId: updated.clusterId,
        endpoint: endpoint(server),
      };
    },
  };
}

export const swarmConnection = createSwarmConnectionService();
