/**
 * Orphaned-resource garbage collector.
 *
 * When a project is deleted while its server (or cloud) is unreachable, the
 * leaked remote resources are recorded in `orphaned_resource` and the DB row
 * is dropped anyway (enforced delete). This sweep reclaims them: for each
 * orphan it probes reachability, destroys the resource idempotently once the
 * host answers, and deletes the record. Unreachable ones are left for the next
 * tick (attempts is bumped so the condition is observable).
 *
 * `runOrphanSweep` is the action; scheduling is owned by the generic jobs
 * module (registered as the "projects:orphan-gc" system job — see
 * modules/jobs/job.registry.ts).
 */

import { repos, tryAcquireAdvisoryLock, type OrphanedResource } from "@repo/db";
import {
  DockerRuntime,
  edgeProxyFor,
  isRuntimeNotFoundError,
  ownsBuiltImage,
  type Platform,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { createReachabilityProbe } from "../../lib/server-reachability";
import { isConnectionLoss } from "../../lib/remote-state";
import { disposePlatform, resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { convergeTargetHostPortClaims } from "../deployments/pinned-host-ports";
import { releaseManagedHostnames } from "../../lib/managed-edge-proxy";
import { connectionHostPortTargetKey } from "../../lib/host-port-target";

interface ProjectTargetSweepPayload {
  slug: string;
  wipeVolumes: boolean;
  containerIds: string[];
  imageRefs: string[];
  artifactRefs: string[];
  volumeNames: string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && !!item))];
}

function readProjectTargetSweep(o: OrphanedResource): ProjectTargetSweepPayload {
  const payload = o.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("project target sweep has no cleanup payload");
  }
  const values = payload as Record<string, unknown>;
  if (typeof values.slug !== "string" || !values.slug.trim()) {
    throw new Error("project target sweep has no project slug");
  }
  if (typeof values.wipeVolumes !== "boolean") {
    throw new Error("project target sweep has no volume-cleanup intent");
  }
  return {
    slug: values.slug,
    wipeVolumes: values.wipeVolumes,
    containerIds: stringArray(values.containerIds),
    imageRefs: stringArray(values.imageRefs),
    artifactRefs: stringArray(values.artifactRefs),
    volumeNames: stringArray(values.volumeNames),
  };
}

async function ignoreRuntimeNotFound(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (!isRuntimeNotFoundError(err)) throw err;
  }
}

/**
 * Replay a project-wide cleanup once an unreachable target returns.
 *
 * The payload preserves DB-known refs, while Docker's label scans recover
 * resources created just before a crash. Volume mounts are inventoried before
 * any container is removed, and later phases run only after earlier ones have
 * fully settled. Keeping this as one durable orphan makes partial retries
 * idempotent without pretending the project id itself is a container id.
 */
async function destroyProjectTargetSweep(platform: Platform, o: OrphanedResource): Promise<void> {
  if (!o.projectId) throw new Error("project target sweep has no project identity");
  const payload = readProjectTargetSweep(o);
  const runtime = platform.runtime;

  if (!(runtime instanceof DockerRuntime)) {
    if (o.runtimeMode !== "bare" || runtime.name !== "bare") {
      throw new Error(`project target sweep resolved an unexpected ${runtime.name} runtime`);
    }
    for (const ref of [...new Set([...payload.containerIds, ...payload.artifactRefs])]) {
      await ignoreRuntimeNotFound(() => runtime.destroy(ref));
    }
    return;
  }

  const discoveredContainerIds = await runtime.listProjectContainerIds(o.projectId);
  const containerIds = [...new Set([...payload.containerIds, ...discoveredContainerIds])];
  const volumeNames = new Set(payload.volumeNames);
  if (payload.wipeVolumes) {
    // Do every inspect first: after even one container is removed, its mount
    // metadata is gone and an interrupted replay could no longer honor the wipe.
    for (const containerId of containerIds) {
      for (const volume of await runtime.inspectNamedVolumes(containerId)) {
        volumeNames.add(volume);
      }
    }
    // The mount list disappears with the container. Commit it before the first
    // destroy so a process crash or transport loss can resume the volume phase.
    await repos.orphanedResource.updatePayload(o.id, {
      ...payload,
      volumeNames: [...volumeNames],
    });
  }

  for (const containerId of containerIds) {
    await ignoreRuntimeNotFound(() => runtime.destroy(containerId));
  }
  for (const artifactRef of payload.artifactRefs) {
    await ignoreRuntimeNotFound(() => runtime.destroy(artifactRef));
  }
  for (const volumeName of volumeNames) {
    await ignoreRuntimeNotFound(() => runtime.removeVolume(volumeName));
  }

  const discoveredImages = await runtime.listProjectImages(o.projectId);
  const imageRefs = new Set(payload.imageRefs.filter(ownsBuiltImage));
  for (const image of discoveredImages) imageRefs.add(image.repoTags[0] ?? image.id);
  for (const imageRef of imageRefs) {
    await ignoreRuntimeNotFound(() => runtime.removeImage(imageRef));
  }
  await ignoreRuntimeNotFound(() => runtime.removeNetwork(payload.slug));
}

/** Destroy one orphaned resource via the right adapter op; not-found = done. */
async function destroyOrphanResource(platform: Platform, o: OrphanedResource): Promise<void> {
  const runtime = platform.runtime;
  try {
    switch (o.resourceType) {
      case "container":
      case "cloud_workspace":
      case "artifact":
        await runtime.destroy(o.ref);
        return;
      case "image":
        // Old releases may have recorded pulled/adopted images as orphans
        // before manifest collection enforced ownership. Never turn that stale
        // bookkeeping into permission to untag shared registry cache.
        if (runtime instanceof DockerRuntime && ownsBuiltImage(o.ref)) {
          await runtime.removeImage(o.ref);
        }
        return;
      case "volume":
        if (runtime instanceof DockerRuntime) await runtime.removeVolume(o.ref);
        return;
      case "network":
        if (runtime instanceof DockerRuntime) await runtime.removeNetwork(o.ref);
        return;
      case "project_target_sweep":
        await destroyProjectTargetSweep(platform, o);
        return;
      case "route":
        await platform.routing.removeRoute(o.ref);
        return;
      case "host_port_claims":
        // No host object to destroy. `reclaimOrphan` converges the target's
        // durable claims after all workload orphans on that target are gone.
        return;
      default:
        return;
    }
  } catch (err) {
    // Already gone on the host → the orphan is reclaimed; treat as success.
    if (isRuntimeNotFoundError(err)) return;
    throw err;
  }
}

function convergesHostPortClaims(resourceType: string): boolean {
  return resourceType === "route" || resourceType === "host_port_claims";
}

async function assertOrphanTargetStillMatches(
  o: OrphanedResource,
  resolved: Awaited<ReturnType<typeof resolveDeploymentPlatform>>,
): Promise<void> {
  const stored = o.targetKey;
  // `server:<id>` is the legacy, mutable format. It cannot prove physical
  // identity, but retaining compatibility is safer than making old rows
  // permanently unreclaimable. Every newly-created row uses local/host:<sha>.
  if (!stored || (stored !== "local" && !stored.startsWith("host:"))) return;

  const candidates = new Set<string>();
  if (resolved.hostPortTarget?.targetKey) candidates.add(resolved.hostPortTarget.targetKey);
  if (candidates.has(stored)) return;
  if (o.serverId) {
    const server = await repos.server.getInOrganization(o.serverId, o.organizationId);
    if (server) {
      candidates.add(
        server.isLocal
          ? "local"
          : connectionHostPortTargetKey({
              sshHost: server.sshHost,
              sshPort: server.sshPort,
              sshJumpHost: server.sshJumpHost,
              sshArgs: server.sshArgs,
            }),
      );
    }
  }
  if (!candidates.has(stored)) {
    throw new Error(
      `deferred cleanup target changed (stored ${stored}; current ${[...candidates].join(", ") || "unknown"})`,
    );
  }
}

/**
 * Attempt to reclaim one orphan. Returns true if destroyed (or already gone) →
 * caller deletes the row; false if the host is unreachable → caller defers.
 * Throws on a real destroy error → caller bumps the attempt count.
 */
async function reclaimOrphan(
  o: OrphanedResource,
  probe: ReturnType<typeof createReachabilityProbe>,
): Promise<boolean> {
  // Cloud resource: no TCP notion — resolve the cloud runtime for the org.
  // A null server id with docker/bare mode is the local self-hosted target, not
  // cloud; older code conflated the two and silently "reclaimed" local orphans
  // through a cloud adapter that never touched the host.
  if (o.runtimeMode === "cloud" || (!o.serverId && !o.runtimeMode)) {
    let cloudPlatform: Platform | null = null;
    try {
      const { platform } = await resolveDeploymentPlatform(
        { deployTarget: "cloud", workspaceId: o.ref },
        { organizationId: o.organizationId },
      );
      cloudPlatform = platform;
      if (platform.runtime.name !== "cloud") return false;
      await destroyOrphanResource(platform, o);
      if (o.resourceType === "route") {
        const { failures } = await releaseManagedHostnames([o.ref], {
          organizationId: o.organizationId,
        });
        if (failures.length > 0) {
          throw new Error(`Cloud edge route not released: ${failures.join(", ")}`);
        }
      }
      return true;
    } catch (err) {
      // Cloud API unreachable → defer; anything else is a real failure.
      if (isConnectionLoss(err)) return false;
      throw err;
    } finally {
      disposePlatform(cloudPlatform);
    }
  }

  // Server-backed: fast-fail if the remote host still isn't answering. A local
  // orphan has no server row to probe and resolves through this process's host
  // target directly.
  if (o.serverId && !(await probe.isReachable(o.serverId))) return false;

  // A docker-mode server platform binds a Docker-over-SSH bridge, and this runs
  // per orphan on a SCHEDULE — releasing it is what keeps a recurring sweep from
  // accumulating one loopback listener per reclaim, forever.
  const resolved = await resolveDeploymentPlatform(
    {
      deployTarget: o.serverId ? "server" : "local",
      runtimeMode: o.runtimeMode === "bare" ? "bare" : "docker",
      ...(o.serverId ? { serverId: o.serverId } : {}),
    },
    { organizationId: o.organizationId },
  );
  try {
    await assertOrphanTargetStillMatches(o, resolved);
    if (
      convergesHostPortClaims(o.resourceType) &&
      o.projectId &&
      (!resolved.hostPortTarget || !resolved.platform.executor)
    ) {
      throw new Error(
        `cannot reclaim ${o.resourceType}: target identity or executor is unavailable`,
      );
    }
    await destroyOrphanResource(resolved.platform, o);
    if (
      convergesHostPortClaims(o.resourceType) &&
      o.projectId &&
      resolved.hostPortTarget &&
      resolved.platform.executor
    ) {
      // The route is gone; only a fresh dump from this same physical target may
      // release its detached project claims. A failed dump throws, keeping the
      // orphan row for a later retry and every claim intact.
      const converged = await convergeTargetHostPortClaims({
        target: resolved.hostPortTarget,
        projectId: o.projectId,
        desiredPublishes: [],
        edgeProxy: edgeProxyFor(resolved.platform.executor, "openresty", { ours: true }),
      });
      if (converged.retained.length > 0) {
        const ports = [...new Set(converged.retained.map((claim) => claim.port))].sort(
          (a, b) => a - b,
        );
        throw new Error(
          `the target edge still references this project's host port(s): ${ports.join(", ")}`,
        );
      }
    }
    if (o.resourceType === "route") {
      // Force-orphan fans a route out to its physical server targets. The
      // managed *.opsh.io registration is global rather than tied to one of
      // those targets, but it must still be released before the last durable
      // retry record can disappear. The operation is namespace-scoped and
      // idempotent, so each target row may safely enforce the same invariant.
      const { failures } = await releaseManagedHostnames([o.ref], {
        organizationId: o.organizationId,
      });
      if (failures.length > 0) {
        throw new Error(`Cloud edge route not released: ${failures.join(", ")}`);
      }
    }
    return true;
  } finally {
    disposePlatform(resolved);
  }
}

async function runOrphanSweepLocked(): Promise<{ reclaimed: number; deferred: number }> {
  const orphans = await repos.orphanedResource.listAll();
  if (orphans.length === 0) return { reclaimed: 0, deferred: 0 };

  const probe = createReachabilityProbe();
  let reclaimed = 0;
  let deferred = 0;
  const targetGroupKey = (orphan: OrphanedResource): string | null =>
    orphan.projectId
      ? [
          orphan.organizationId,
          orphan.projectId,
          orphan.targetKey ??
            (orphan.serverId
              ? `server:${orphan.serverId}`
              : orphan.runtimeMode === "cloud" || !orphan.runtimeMode
                ? "cloud"
                : "local"),
        ].join("\0")
      : null;
  // A route disappearance proves only that the edge stopped dialling a port; it
  // cannot prove a failed/stopped workload surrendered the bind. Hold route
  // cleanup—and therefore claim convergence—until every non-route orphan for the
  // same project/target has been reclaimed. Counts are decremented only after the
  // orphan row itself is deleted successfully.
  const pendingResourcesByTarget = new Map<string, number>();
  for (const orphan of orphans) {
    const key = targetGroupKey(orphan);
    if (!key || convergesHostPortClaims(orphan.resourceType)) continue;
    pendingResourcesByTarget.set(key, (pendingResourcesByTarget.get(key) ?? 0) + 1);
  }

  for (const o of orphans) {
    try {
      // Orphan rows are written just before the originating project is hard
      // deleted. If a later unlink/delete step failed—or this sweep races that
      // narrow window—the project still exists and remains authoritative. Never
      // let GC tear down its workload/routes or release its claims.
      if (o.projectId && (await repos.project.findById(o.projectId))) {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
        continue;
      }
      // Route orphan rows reserve their hostname until every physical/global
      // cleanup step succeeds. This is defense-in-depth for legacy rows and any
      // caller that bypassed the repository's post-insert reservation check:
      // never remove a vhost now owned by a live domain.
      if (o.resourceType === "route" && (await repos.domain.findByHostname(o.ref))) {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
        continue;
      }
      const groupKey = targetGroupKey(o);
      if (
        convergesHostPortClaims(o.resourceType) &&
        groupKey &&
        (pendingResourcesByTarget.get(groupKey) ?? 0) > 0
      ) {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
        continue;
      }
      if (await reclaimOrphan(o, probe)) {
        await repos.orphanedResource.delete(o.id);
        if (groupKey && !convergesHostPortClaims(o.resourceType)) {
          pendingResourcesByTarget.set(
            groupKey,
            Math.max(0, (pendingResourcesByTarget.get(groupKey) ?? 1) - 1),
          );
        }
        reclaimed++;
      } else {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
      }
    } catch (err) {
      await repos.orphanedResource.bumpAttempt(o.id).catch(() => {});
      deferred++;
      console.error(`[orphan-gc] ${o.resourceType} ${o.ref} failed:`, safeErrorMessage(err));
    }
  }

  return { reclaimed, deferred };
}

// The scheduler's wall-clock timeout cannot cancel an SSH/Docker mutation. Keep
// one real sweep alive until its work settles and make overlapping ticks skip,
// instead of letting a late first sweep race hostname reuse or a second cleanup.
let sweepInProgress = false;

export async function runOrphanSweep(): Promise<{ reclaimed: number; deferred: number }> {
  if (sweepInProgress) return { reclaimed: 0, deferred: 0 };
  sweepInProgress = true;
  let lock: Awaited<ReturnType<typeof tryAcquireAdvisoryLock>> = null;
  try {
    lock = await tryAcquireAdvisoryLock("projects:orphan-gc");
    if (!lock) return { reclaimed: 0, deferred: 0 };
    return await runOrphanSweepLocked();
  } finally {
    try {
      await lock?.release();
    } finally {
      sweepInProgress = false;
    }
  }
}
