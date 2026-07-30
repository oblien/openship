/** Explicit control surface for the cluster-scoped OpenShip Swarm Edge. */

import { AppError } from "@repo/core";
import { SwarmEdgeError, SwarmEdgeManager, type Platform } from "@repo/adapters";
import { repos } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";

type EdgePlatform = Pick<Platform, "stackRuntime" | "executor">;

interface Dependencies {
  featureEnabled: () => boolean;
  getServer: (serverId: string, organizationId: string) => ReturnType<typeof repos.server.getInOrganization>;
  resolvePlatform: (
    target: "server",
    runtimeMode: "docker",
    serverId: string,
    organizationId: string,
    orchestratorMode: "swarm",
  ) => Promise<EdgePlatform>;
}

function edgeUnavailable(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof SwarmEdgeError) throw new AppError(error.message, 409, "SWARM_EDGE_UNAVAILABLE");
  throw new AppError(
    "Unable to inspect or configure the OpenShip Swarm Edge. Verify the manager connection and Docker permissions.",
    503,
    "SWARM_EDGE_UNAVAILABLE",
  );
}

export function createSwarmEdgeService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    featureEnabled: swarmSupportEnabled,
    getServer: (serverId, organizationId) => repos.server.getInOrganization(serverId, organizationId),
    resolvePlatform: resolveTargetPlatform,
    ...overrides,
  };

  async function manager(serverId: string, organizationId: string): Promise<SwarmEdgeManager> {
    if (!deps.featureEnabled()) {
      throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
    }
    const server = await deps.getServer(serverId, organizationId);
    if (!server) throw new AppError("Server not found.", 404, "NOT_FOUND");
    try {
      const platform = await deps.resolvePlatform("server", "docker", server.id, organizationId, "swarm");
      if (!platform.stackRuntime || !platform.executor) {
        throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      }
      return new SwarmEdgeManager(platform.stackRuntime, platform.executor);
    } catch (error) {
      return edgeUnavailable(error);
    }
  }

  return {
    async status(serverId: string, organizationId: string) {
      const edge = await manager(serverId, organizationId);
      try {
        return await edge.status();
      } catch (error) {
        return edgeUnavailable(error);
      }
    },

    /** This endpoint is intentionally separate from normal stack deploy/claim. */
    async ensure(serverId: string, organizationId: string) {
      const edge = await manager(serverId, organizationId);
      try {
        return await edge.ensure();
      } catch (error) {
        return edgeUnavailable(error);
      }
    },
  };
}

export const swarmEdge = createSwarmEdgeService();
