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

import { repos, type OrphanedResource } from "@repo/db";
import { DockerRuntime, isRuntimeNotFoundError, type RuntimeAdapter } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { createReachabilityProbe } from "../../lib/server-reachability";
import { isConnectionLoss } from "../../lib/remote-state";
import { resolveTargetPlatform, resolveDeploymentPlatform } from "../../lib/deployment-runtime";

/** Destroy one orphaned resource via the right adapter op; not-found = done. */
async function destroyOrphanResource(runtime: RuntimeAdapter, o: OrphanedResource): Promise<void> {
  try {
    switch (o.resourceType) {
      case "container":
      case "cloud_workspace":
      case "artifact":
        await runtime.destroy(o.ref);
        return;
      case "image":
        if (runtime instanceof DockerRuntime) await runtime.removeImage(o.ref);
        return;
      case "volume":
        if (runtime instanceof DockerRuntime) await runtime.removeVolume(o.ref);
        return;
      case "network":
        if (runtime instanceof DockerRuntime) await runtime.removeNetwork(o.ref);
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
  if (o.runtimeMode === "cloud" || !o.serverId) {
    try {
      const { platform } = await resolveDeploymentPlatform(
        { deployTarget: "cloud", workspaceId: o.ref },
        { organizationId: o.organizationId },
      );
      if (platform.runtime.name !== "cloud") return false;
      await destroyOrphanResource(platform.runtime, o);
      return true;
    } catch (err) {
      // Cloud API unreachable → defer; anything else is a real failure.
      if (isConnectionLoss(err)) return false;
      throw err;
    }
  }

  // Server-backed: fast-fail if the host still isn't answering.
  if (!(await probe.isReachable(o.serverId))) return false;

  const platform = await resolveTargetPlatform(
    "server",
    o.runtimeMode === "bare" ? "bare" : "docker",
    o.serverId,
    o.organizationId,
  );
  await destroyOrphanResource(platform.runtime, o);
  return true;
}

export async function runOrphanSweep(): Promise<{ reclaimed: number; deferred: number }> {
  const orphans = await repos.orphanedResource.listAll();
  if (orphans.length === 0) return { reclaimed: 0, deferred: 0 };

  const probe = createReachabilityProbe();
  let reclaimed = 0;
  let deferred = 0;

  for (const o of orphans) {
    try {
      if (await reclaimOrphan(o, probe)) {
        await repos.orphanedResource.delete(o.id);
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
