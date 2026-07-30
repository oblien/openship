/** Explicit control surface for the cluster-scoped OpenShip Swarm Edge. */

import { AppError } from "@repo/core";
import {
  probeEdge,
  SwarmEdgeCutoverError,
  SwarmEdgeCutoverManager,
  SwarmEdgeError,
  SwarmEdgeManager,
  type Platform,
} from "@repo/adapters";
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
  if (error instanceof SwarmEdgeCutoverError) throw new AppError(error.message, 409, "SWARM_EDGE_CUTOVER_FAILED");
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

  async function platformFor(serverId: string, organizationId: string): Promise<EdgePlatform> {
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
      return platform;
    } catch (error) {
      return edgeUnavailable(error);
    }
  }

  async function manager(serverId: string, organizationId: string): Promise<SwarmEdgeManager> {
    const platform = await platformFor(serverId, organizationId);
    return new SwarmEdgeManager(platform.stackRuntime!, platform.executor!);
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

    /** Read-only plan: detects host/container/Swarm owners before any mutation. */
    async cutoverPlan(serverId: string, organizationId: string) {
      const platform = await platformFor(serverId, organizationId);
      try {
        const cutover = new SwarmEdgeCutoverManager(platform.stackRuntime!, platform.executor!);
        return {
          portOwnership: await probeEdge(platform.executor!),
          cutover: await cutover.plan(),
        };
      } catch (error) {
        return edgeUnavailable(error);
      }
    },

    /** Requires confirmation/maintenance acknowledgement at the HTTP boundary. */
    async cutover(
      serverId: string,
      organizationId: string,
      input: { serviceId: string; specVersion: number; confirmedServiceName: string },
    ) {
      const platform = await platformFor(serverId, organizationId);
      try {
        const cutover = new SwarmEdgeCutoverManager(platform.stackRuntime!, platform.executor!);
        const plan = await cutover.plan();
        if (plan.kind !== "swarm-service") {
          throw new AppError(plan.message, 409, "SWARM_EDGE_CUTOVER_UNAVAILABLE");
        }
        if (plan.serviceName !== input.confirmedServiceName) {
          throw new AppError("Type the exact current router service name to confirm this cutover.", 409, "SWARM_EDGE_CUTOVER_CONFIRMATION_REQUIRED");
        }
        return await cutover.execute({ serviceId: input.serviceId, specVersion: input.specVersion });
      } catch (error) {
        return edgeUnavailable(error);
      }
    },

    async recoverCutover(serverId: string, organizationId: string) {
      const platform = await platformFor(serverId, organizationId);
      try {
        return await new SwarmEdgeCutoverManager(platform.stackRuntime!, platform.executor!).recover();
      } catch (error) {
        return edgeUnavailable(error);
      }
    },
  };
}

export const swarmEdge = createSwarmEdgeService();
