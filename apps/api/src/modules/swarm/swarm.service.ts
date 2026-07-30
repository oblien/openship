/**
 * Read-only Swarm inspection service.
 *
 * All manager access flows through the normal org-scoped target resolver. The
 * StackRuntimeAdapter presently exposes only probe/discover, so this module
 * cannot mutate a Swarm service or stack by construction.
 */

import {
  SwarmProbeError,
  deriveSwarmStackHealth,
  type Platform,
  type SwarmDiscoverySnapshot,
  type SwarmStackHealth,
} from "@repo/adapters";
import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";

const DISCOVERY_CACHE_MS = 2_000;

type SwarmPlatform = Pick<Platform, "stackRuntime">;

export interface SwarmDiscoveryDependencies {
  featureEnabled: () => boolean;
  getServer: (serverId: string, organizationId: string) => ReturnType<typeof repos.server.getInOrganization>;
  resolvePlatform: (
    target: "server",
    runtimeMode: "docker",
    serverId: string,
    organizationId: string,
    orchestratorMode: "swarm",
  ) => Promise<SwarmPlatform>;
  now: () => number;
}

interface CachedSnapshot {
  expiresAt: number;
  snapshot: SwarmDiscoverySnapshot;
}

function toStableSwarmError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof SwarmProbeError) {
    const status = error.code === "SWARM_INACTIVE" || error.code === "SWARM_MANAGER_REQUIRED" ? 409 : 503;
    throw new AppError(error.message, status, error.code);
  }
  throw new AppError(
    "Unable to inspect this Docker Swarm manager. Verify the manager connection and Docker permissions.",
    503,
    "SWARM_MANAGER_UNAVAILABLE",
  );
}

/**
 * Factory keeps manager access testable without a Hono/auth harness. A single
 * instance is shared by controllers, giving dashboard polling a small bounded
 * cache while never persisting a manager snapshot as an authoritative record.
 */
export function createSwarmDiscoveryService(
  dependencies: Partial<SwarmDiscoveryDependencies> = {},
) {
  const deps: SwarmDiscoveryDependencies = {
    featureEnabled: swarmSupportEnabled,
    getServer: (serverId, organizationId) => repos.server.getInOrganization(serverId, organizationId),
    resolvePlatform: resolveTargetPlatform,
    now: Date.now,
    ...dependencies,
  };
  const snapshots = new Map<string, CachedSnapshot>();

  function assertEnabled(): void {
    if (!deps.featureEnabled()) {
      throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
    }
  }

  async function runtimeFor(serverId: string, organizationId: string) {
    assertEnabled();
    const server = await deps.getServer(serverId, organizationId);
    if (!server) throw new NotFoundError("Server", serverId);

    try {
      const platform = await deps.resolvePlatform("server", "docker", server.id, organizationId, "swarm");
      if (!platform.stackRuntime) {
        throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      }
      return platform.stackRuntime;
    } catch (error) {
      return toStableSwarmError(error);
    }
  }

  async function probe(serverId: string, organizationId: string) {
    const runtime = await runtimeFor(serverId, organizationId);
    try {
      return await runtime.probe();
    } catch (error) {
      return toStableSwarmError(error);
    }
  }

  async function discover(serverId: string, organizationId: string): Promise<SwarmDiscoverySnapshot> {
    const cacheKey = `${organizationId}:${serverId}`;
    const cached = snapshots.get(cacheKey);
    if (cached && cached.expiresAt > deps.now()) return cached.snapshot;

    const runtime = await runtimeFor(serverId, organizationId);
    try {
      const snapshot = await runtime.discover();
      snapshots.set(cacheKey, { snapshot, expiresAt: deps.now() + DISCOVERY_CACHE_MS });
      return snapshot;
    } catch (error) {
      return toStableSwarmError(error);
    }
  }

  async function summary(serverId: string, organizationId: string) {
    const snapshot = await discover(serverId, organizationId);
    const eligibleNodeCount = snapshot.nodes.filter(
      (node) => node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
    ).length;
    const health = snapshot.stacks.map((stack) => deriveSwarmStackHealth({
      stackName: stack.name,
      services: snapshot.services,
      tasks: snapshot.tasks,
      eligibleNodeCount,
    }));
    return {
      manager: snapshot.manager,
      observedAt: snapshot.observedAt,
      stacks: health,
      diagnostics: snapshot.diagnostics,
    };
  }

  async function stack(serverId: string, organizationId: string, stackName: string): Promise<{
    stack: SwarmDiscoverySnapshot["stacks"][number];
    health: SwarmStackHealth;
    services: SwarmDiscoverySnapshot["services"];
    tasks: SwarmDiscoverySnapshot["tasks"];
    observedAt: string;
    diagnostics: SwarmDiscoverySnapshot["diagnostics"];
  }> {
    const snapshot = await discover(serverId, organizationId);
    const found = snapshot.stacks.find((candidate) => candidate.name === stackName);
    if (!found) throw new NotFoundError("Swarm stack", stackName);
    const services = snapshot.services.filter((service) => service.stackName === stackName);
    const serviceIds = new Set(services.map((service) => service.id));
    const tasks = snapshot.tasks.filter((task) => serviceIds.has(task.serviceId));
    const eligibleNodeCount = snapshot.nodes.filter(
      (node) => node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
    ).length;
    return {
      stack: found,
      health: deriveSwarmStackHealth({ stackName, services, tasks, eligibleNodeCount }),
      services,
      tasks,
      observedAt: snapshot.observedAt,
      diagnostics: snapshot.diagnostics,
    };
  }

  return {
    probe,
    discover,
    summary,
    stack,
    clearCache: () => snapshots.clear(),
  };
}

export const swarmDiscovery = createSwarmDiscoveryService();
