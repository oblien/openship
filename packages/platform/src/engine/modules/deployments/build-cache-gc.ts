/**
 * Host-wide Docker build-cache collection.
 *
 * BuildKit cache records cannot be attributed reliably to a project: unlike
 * final images, intermediate records do not retain our `openship.project`
 * label. Automatic cleanup is therefore intentionally host-scoped and bounded,
 * while the dashboard's explicit action performs a full unused-cache prune on
 * the host that owns the selected project.
 */

import {
  DockerRuntime,
  getPlatform,
  type BuildCachePruneOptions,
  type BuildCachePruneResult,
} from "@repo/adapters";
import { repos, withAdvisoryLock, type Project, type Server } from "@repo/db";
import { AppError, safeErrorMessage } from "@repo/core";
import { createServerDockerRuntime } from "@repo/platform/engine/lib/deployment-runtime";
import { withKeyedMutex } from "@repo/platform/engine/lib/provision-lock";
import { resolveProjectDeployTarget } from "@repo/platform/engine/modules/projects/project-deploy-target";

/** Keep a useful LRU cache while putting a hard ceiling on daily accumulation. */
export const AUTOMATIC_BUILD_CACHE_KEEP_BYTES = 5 * 1024 ** 3;

export interface BuildCacheTarget {
  /** Stable physical-host identity used for de-duplication and locking. */
  key: string;
  serverId: string | null;
  organizationId: string | null;
}

type CacheProject = Pick<
  Project,
  "id" | "organizationId" | "cloudWorkspaceId" | "serverId" | "activeDeploymentId"
>;

interface BuildCacheRuntime {
  pruneBuildCache(options?: BuildCachePruneOptions): Promise<BuildCachePruneResult>;
  dispose?(): Promise<void>;
}

export interface BuildCacheGcDependencies {
  listServers(): Promise<Server[]>;
  hasLocalDockerRuntime(): boolean;
  findServer(
    serverId: string,
    organizationId: string,
  ): Promise<Pick<Server, "id" | "isLocal"> | undefined>;
  resolveProjectTarget(
    project: CacheProject,
  ): Promise<{ deployTarget: "local" | "server" | "cloud" | null; serverId: string | null }>;
  createRuntime(target: BuildCacheTarget): Promise<BuildCacheRuntime>;
  runLocked<T>(targetKey: string, run: () => Promise<T>): Promise<T>;
}

const defaultDependencies: BuildCacheGcDependencies = {
  listServers: () => repos.server.list(),
  hasLocalDockerRuntime: () => getPlatform().runtime.name === "docker",
  findServer: (serverId, organizationId) =>
    repos.server.getInOrganization(serverId, organizationId),
  resolveProjectTarget: (project) => resolveProjectDeployTarget(project),
  createRuntime: async (target) => {
    if (target.serverId) {
      if (!target.organizationId) {
        throw new Error(`Docker server ${target.serverId} has no owning organization`);
      }
      return createServerDockerRuntime(target.serverId, target.organizationId);
    }
    if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION !== "true")
      throw new AppError("Host execution is disabled by this native installation's policy", 403, "HOST_EXECUTION_DISABLED");
    return DockerRuntime.create({ transport: "socket" });
  },
  runLocked: (targetKey, run) => {
    const lockKey = `build-cache-prune:${targetKey}`;
    // The in-process layer is required for PGlite, where advisory locks are a
    // passthrough. The DB layer serializes API replicas on Postgres.
    return withKeyedMutex(lockKey, () => withAdvisoryLock(lockKey, run));
  },
};

/**
 * One target per configured Docker host. Local aliases collapse to one entry;
 * remote server ids remain distinct because that is OpenShip's physical target
 * identity everywhere else too. The platform runtime decides whether the local
 * socket is a Docker target, including when its last project has been deleted
 * and there is no auto-registered server row (or project row) left to infer from.
 */
export function collectBuildCacheTargets(
  servers: ReadonlyArray<Pick<Server, "id" | "organizationId" | "isLocal">>,
  hasLocalDockerRuntime: boolean,
): BuildCacheTarget[] {
  const targets = new Map<string, BuildCacheTarget>();
  for (const server of servers) {
    if (server.isLocal) {
      if (hasLocalDockerRuntime) {
        targets.set("local", {
          key: "local",
          serverId: null,
          organizationId: server.organizationId,
        });
      }
      continue;
    }
    // Legacy unowned rows cannot be resolved through the tenant-safe server
    // factory. They are not actionable until ownership is repaired.
    if (!server.organizationId) continue;
    targets.set(`server:${server.id}`, {
      key: `server:${server.id}`,
      serverId: server.id,
      organizationId: server.organizationId,
    });
  }

  if (hasLocalDockerRuntime && !targets.has("local")) {
    targets.set("local", {
      key: "local",
      serverId: null,
      organizationId: null,
    });
  }
  return [...targets.values()];
}

async function pruneTarget(
  target: BuildCacheTarget,
  options: BuildCachePruneOptions,
  deps: BuildCacheGcDependencies,
): Promise<BuildCachePruneResult> {
  return deps.runLocked(target.key, async () => {
    const runtime = await deps.createRuntime(target);
    try {
      return await runtime.pruneBuildCache(options);
    } finally {
      await runtime.dispose?.();
    }
  });
}

/** Full, operator-requested prune for the Docker host backing one project. */
export async function clearProjectBuildCache(
  project: CacheProject,
  deps: BuildCacheGcDependencies = defaultDependencies,
): Promise<BuildCachePruneResult & { target: "local" | "server"; serverId: string | null }> {
  const resolved = await deps.resolveProjectTarget(project);
  if (resolved.deployTarget === "cloud" || project.cloudWorkspaceId) {
    throw new AppError(
      "Cloud build cache is managed by the cloud runtime and cannot be cleared from this host.",
      409,
      "BUILD_CACHE_NOT_LOCAL",
    );
  }
  if (resolved.deployTarget === "server" && !resolved.serverId) {
    throw new AppError(
      "This project's Docker server could not be resolved.",
      409,
      "BUILD_CACHE_TARGET_MISSING",
    );
  }

  let serverId = resolved.deployTarget === "server" ? resolved.serverId : null;
  if (serverId) {
    const server = await deps.findServer(serverId, project.organizationId);
    if (!server) {
      throw new AppError(
        "This project's Docker server could not be resolved.",
        409,
        "BUILD_CACHE_TARGET_MISSING",
      );
    }
    // The auto-registered "This Server" row and an unbound local project both
    // address the same socket. Canonicalize them to one identity so a manual
    // prune and the scheduled sweep share the same local lock.
    if (server.isLocal) serverId = null;
  }

  // An unbound/never-deployed self-hosted project builds on the local daemon.
  const target: BuildCacheTarget = {
    key: serverId ? `server:${serverId}` : "local",
    serverId,
    organizationId: project.organizationId,
  };
  const result = await pruneTarget(target, { all: true }, deps);
  return { ...result, target: serverId ? "server" : "local", serverId };
}

export interface BuildCacheGcSummary {
  hostsScanned: number;
  cachesDeleted: number;
  bytesReclaimed: number;
  errors: number;
}

/** Daily bounded prune, isolated per host so one unreachable server cannot stop the sweep. */
export async function runBuildCacheGcSweep(
  deps: BuildCacheGcDependencies = defaultDependencies,
): Promise<BuildCacheGcSummary> {
  const summary: BuildCacheGcSummary = {
    hostsScanned: 0,
    cachesDeleted: 0,
    bytesReclaimed: 0,
    errors: 0,
  };

  let targets: BuildCacheTarget[];
  try {
    targets = collectBuildCacheTargets(await deps.listServers(), deps.hasLocalDockerRuntime());
  } catch (err) {
    summary.errors += 1;
    console.error(`[build-cache-gc] target discovery failed: ${safeErrorMessage(err)}`);
    return summary;
  }

  for (const target of targets) {
    summary.hostsScanned += 1;
    try {
      const result = await pruneTarget(
        target,
        { all: true, keepStorageBytes: AUTOMATIC_BUILD_CACHE_KEEP_BYTES },
        deps,
      );
      summary.cachesDeleted += result.cachesDeleted.length;
      summary.bytesReclaimed += result.spaceReclaimed;
      if (result.spaceReclaimed > 0) {
        console.log(
          `[build-cache-gc] ${target.key}: removed ${result.cachesDeleted.length} cache record(s), ` +
            `${(result.spaceReclaimed / 1e9).toFixed(2)} GB reclaimed`,
        );
      }
    } catch (err) {
      summary.errors += 1;
      console.error(`[build-cache-gc] ${target.key} sweep failed: ${safeErrorMessage(err)}`);
    }
  }
  return summary;
}
