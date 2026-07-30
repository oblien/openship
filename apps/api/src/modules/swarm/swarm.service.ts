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
import { inferSwarmRoutingUrls, readSwarmRoutingLabels } from "./swarm-routing-labels";

const DISCOVERY_CACHE_MS = 2_000;
export const DEFAULT_SWARM_TASK_PAGE_SIZE = 100;
export const MAX_SWARM_TASK_PAGE_SIZE = 250;

type SwarmPlatform = Pick<Platform, "stackRuntime">;

export interface SwarmDiscoveryDependencies {
  featureEnabled: () => boolean;
  getServer: (
    serverId: string,
    organizationId: string,
  ) => ReturnType<typeof repos.server.getInOrganization>;
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

type PublicSwarmStackHealth = Omit<SwarmStackHealth, "services"> & {
  services: Array<Omit<SwarmStackHealth["services"][number], "currentTasks">>;
};

function boundedPageValue(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

/** Current task rows are useful only while deriving health; never duplicate them in an API DTO. */
function publicHealth(health: SwarmStackHealth): PublicSwarmStackHealth {
  return {
    ...health,
    services: health.services.map(({ currentTasks: _currentTasks, ...service }) => service),
  };
}

function toStableSwarmError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof SwarmProbeError) {
    const status =
      error.code === "SWARM_INACTIVE" || error.code === "SWARM_MANAGER_REQUIRED" ? 409 : 503;
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
    getServer: (serverId, organizationId) =>
      repos.server.getInOrganization(serverId, organizationId),
    resolvePlatform: resolveTargetPlatform,
    now: Date.now,
    ...dependencies,
  };
  const snapshots = new Map<string, CachedSnapshot>();
  const pendingDiscoveries = new Map<string, Promise<SwarmDiscoverySnapshot>>();

  function assertEnabled(): void {
    if (!deps.featureEnabled()) {
      throw new AppError(
        "Docker Swarm support is not enabled on this OpenShip instance.",
        404,
        "SWARM_FEATURE_DISABLED",
      );
    }
  }

  async function runtimeFor(serverId: string, organizationId: string) {
    assertEnabled();
    const server = await deps.getServer(serverId, organizationId);
    if (!server) throw new NotFoundError("Server", serverId);

    try {
      const platform = await deps.resolvePlatform(
        "server",
        "docker",
        server.id,
        organizationId,
        "swarm",
      );
      if (!platform.stackRuntime) {
        throw new AppError(
          "Docker Swarm is unavailable for this target.",
          503,
          "SWARM_MANAGER_UNAVAILABLE",
        );
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

  async function discover(
    serverId: string,
    organizationId: string,
  ): Promise<SwarmDiscoverySnapshot> {
    const cacheKey = `${organizationId}:${serverId}`;
    const cached = snapshots.get(cacheKey);
    if (cached && cached.expiresAt > deps.now()) return cached.snapshot;
    const pending = pendingDiscoveries.get(cacheKey);
    if (pending) return pending;

    const refresh = (async () => {
      const runtime = await runtimeFor(serverId, organizationId);
      try {
        const snapshot = await runtime.discover();
        snapshots.set(cacheKey, { snapshot, expiresAt: deps.now() + DISCOVERY_CACHE_MS });
        return snapshot;
      } catch (error) {
        return toStableSwarmError(error);
      } finally {
        pendingDiscoveries.delete(cacheKey);
      }
    })();
    pendingDiscoveries.set(cacheKey, refresh);
    return refresh;
  }

  async function summary(serverId: string, organizationId: string) {
    const snapshot = await discover(serverId, organizationId);
    const eligibleNodeCount = snapshot.nodes.filter(
      (node) =>
        node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
    ).length;
    const health = snapshot.stacks.map((stack) =>
      publicHealth(
        deriveSwarmStackHealth({
          stackName: stack.name,
          services: snapshot.services,
          tasks: snapshot.tasks,
          eligibleNodeCount,
        }),
      ),
    );
    return {
      manager: snapshot.manager,
      observedAt: snapshot.observedAt,
      stacks: health,
      diagnostics: snapshot.diagnostics,
    };
  }

  async function stack(
    serverId: string,
    organizationId: string,
    stackName: string,
    pagination: { taskOffset?: number; taskLimit?: number } = {},
  ): Promise<{
    stack: SwarmDiscoverySnapshot["stacks"][number];
    health: PublicSwarmStackHealth;
    services: Array<
      Omit<SwarmDiscoverySnapshot["services"][number], "labels"> & {
        routingLabels: ReturnType<typeof readSwarmRoutingLabels>;
        routingUrls: string[];
      }
    >;
    tasks: SwarmDiscoverySnapshot["tasks"];
    taskPage: {
      offset: number;
      limit: number;
      total: number;
      hasPrevious: boolean;
      hasNext: boolean;
    };
    observedAt: string;
    diagnostics: SwarmDiscoverySnapshot["diagnostics"];
  }> {
    const snapshot = await discover(serverId, organizationId);
    const found = snapshot.stacks.find((candidate) => candidate.name === stackName);
    if (!found) throw new NotFoundError("Swarm stack", stackName);
    const liveServices = snapshot.services.filter((service) => service.stackName === stackName);
    const services = liveServices.map(({ labels, ...service }) => {
      const routingLabels = readSwarmRoutingLabels(labels);
      return { ...service, routingLabels, routingUrls: inferSwarmRoutingUrls(routingLabels) };
    });
    const serviceIds = new Set(services.map((service) => service.id));
    const allTasks = snapshot.tasks
      .filter((task) => serviceIds.has(task.serviceId))
      .sort(
        (left, right) =>
          left.serviceName.localeCompare(right.serviceName) ||
          (left.slot ?? Number.MAX_SAFE_INTEGER) - (right.slot ?? Number.MAX_SAFE_INTEGER) ||
          right.observedAt.localeCompare(left.observedAt) ||
          left.id.localeCompare(right.id),
      );
    const taskLimit =
      boundedPageValue(
        pagination.taskLimit === undefined ? undefined : String(pagination.taskLimit),
        DEFAULT_SWARM_TASK_PAGE_SIZE,
        MAX_SWARM_TASK_PAGE_SIZE,
      ) || DEFAULT_SWARM_TASK_PAGE_SIZE;
    const taskOffset = boundedPageValue(
      pagination.taskOffset === undefined ? undefined : String(pagination.taskOffset),
      0,
      Math.max(0, Math.floor((allTasks.length - 1) / taskLimit) * taskLimit),
    );
    const tasks = allTasks.slice(taskOffset, taskOffset + taskLimit);
    const eligibleNodeCount = snapshot.nodes.filter(
      (node) =>
        node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
    ).length;
    return {
      stack: found,
      health: publicHealth(
        deriveSwarmStackHealth({
          stackName,
          services: liveServices,
          tasks: allTasks,
          eligibleNodeCount,
        }),
      ),
      services,
      tasks,
      taskPage: {
        offset: taskOffset,
        limit: taskLimit,
        total: allTasks.length,
        hasPrevious: taskOffset > 0,
        hasNext: taskOffset + tasks.length < allTasks.length,
      },
      observedAt: snapshot.observedAt,
      diagnostics: snapshot.diagnostics,
    };
  }

  return {
    probe,
    discover,
    summary,
    stack,
    clearCache: () => {
      snapshots.clear();
      pendingDiscoveries.clear();
    },
  };
}

export const swarmDiscovery = createSwarmDiscoveryService();
