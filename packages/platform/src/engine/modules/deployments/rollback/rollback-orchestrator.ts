/**
 * Rollback Orchestrator — owns retention policy and executes restores.
 *
 * ── Retention ────────────────────────────────────────────────────────────
 *
 *   1. ON EVERY SUCCESSFUL DEPLOY the previous release is marked retained
 *      (`artifact_retained_at`), and — for runtimes whose artifact is a
 *      durable unit (bare/cloud, capability `unitRestore`) whose project asked
 *      to keep artifacts — that unit is stopped-but-kept via `runtime.archive`.
 *      On Docker there is nothing to stop: the redeploy already removed the old
 *      container, and the IMAGE is the artifact — retained by the
 *      rollback-window keep set in `image-gc`.
 *
 *   2. AUTO-PURGE ON OVERFLOW — `prune` drops the oldest unpinned releases
 *      beyond `resolveRollbackWindow(project)` (explicit override, else the
 *      instance default of five). Active and pinned releases are exempt.
 *
 * ── Restore ──────────────────────────────────────────────────────────────
 *
 * `rollback(id)` asks `planRestore` how this particular release can come back
 * (see restore-plan.ts for the modes and why), then executes:
 *
 *   redeploy-pinned / reacquire-image / rebuild → ONE `triggerDeployment` call
 *     carrying the target's frozen config + env. Retained images are pinned;
 *     an expired release image is pulled again from its frozen concrete ref;
 *     only a source rebuild uses the commit/repository. A restore is a real
 *     deployment: it gets the deploy pipeline's env, ports, volumes, labels,
 *     network, routing, health gate and stabilization watch for free, its own
 *     logs and SSE stream, and — because `onSuccess` reuses the version number
 *     for a commit — rolling back to v2 shows up as v2 again. The active pointer
 *     only ever moves FORWARD on success, so a failed restore leaves the current
 *     release serving.
 *
 *   unit-swap → `runtime.makeActive`, then probe and commit the pointer, with
 *     a compensating swap-back if the DB write fails.
 *
 * A restore is itself restorable: it records the release it moved away from as
 * `commit_sha_before`.
 */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos, type Deployment, type Project } from "@repo/db";
import { BareRuntime, DockerRuntime, type DeploymentRef, type ResourceConfig } from "@repo/adapters";
import { AppError, safeErrorMessage } from "@repo/core";
import { isArtifactRef, usableRef } from "../../../lib/container-ref";
import { resolveDeploymentRuntime } from "../../../lib/deployment-runtime";
import { withProjectRuntimeLock } from "../../../lib/project-runtime-lock";
import {
  checkNoActiveBuild,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "../build.service";
import { buildBackgroundContext } from "../../../lib/background-context";
import { retainedArtifacts, effectiveServiceArtifacts } from "../retained-artifacts";
import { withRetentionLock } from "../retention-lock";
import { withoutPinnedArtifacts } from "../pinned-artifacts";
import {
  planRestore,
  planNeedsRepository,
  shouldRetainArtifact,
  staticReleaseDir,
  ROLLBACK_ERROR_CODES,
  type RestorePlan,
} from "./restore-plan";

export { ROLLBACK_ERROR_CODES, planNeedsRepository, shouldRetainArtifact } from "./restore-plan";
export type { RestorePlan } from "./restore-plan";

/** Project the DB Deployment row down to the minimal DeploymentRef the
 *  runtime primitives consume. Keeps the adapter layer free of
 *  DB-specific shapes. */
function toRef(dep: Deployment): DeploymentRef {
  return {
    id: dep.id,
    projectId: dep.projectId,
    imageRef: dep.imageRef,
    containerId: dep.containerId,
  };
}

/**
 * Called by the deployment lifecycle when a new deployment goes `ready`.
 * Retains the previous release, marks both rows retained, prunes past the
 * window, then reclaims superseded images. An unfinished worker defers cleanup
 * until its final acknowledgement, after all deployment activity stops.
 *
 * Idempotent. Every step is best-effort: the new deployment is already live and
 * a bookkeeping failure must never roll it back.
 */
export async function onDeploymentReady(opts: {
  newDeployment: Deployment;
  previousActive: Deployment | null;
}): Promise<void> {
  return withProjectRuntimeLock(opts.newDeployment.projectId, () => onDeploymentReadyUnlocked(opts));
}

async function onDeploymentReadyUnlocked(opts: {
  newDeployment: Deployment;
  previousActive: Deployment | null;
}): Promise<void> {
  const { newDeployment, previousActive } = opts;
  const project = await repos.project.findById(newDeployment.projectId).catch(() => null);
  if (!project || project.deletionInProgress || project.activeDeploymentId !== newDeployment.id) return;

  if (previousActive && previousActive.id !== newDeployment.id) {
    try {
      // Only a durable-unit runtime has something to stop-and-keep, and only
      // when the project wants artifacts held. Docker's artifact is the image
      // (retained by the keep set) and its container is already gone.
      if (shouldRetainArtifact(project) && previousActive.containerId !== newDeployment.containerId) {
        const { runtime } = await resolveDeploymentRuntime(previousActive);
        try {
          if (runtime.supports("unitRestore") && runtime.makeActive && !isArtifactRef(previousActive.containerId)) {
            await runtime.archive(toRef(previousActive));
          }
        } finally {
          await runtime.dispose?.();
        }
      }
      await repos.deployment.setArtifactRetainedAt(previousActive.id, new Date());
    } catch (err) {
      console.error(
        `[rollback-orchestrator] Failed to retain previous deployment ${previousActive.id}:`,
        err,
      );
    }
  }

  // The new deployment's own artifact is restorable by definition — this is
  // what makes the dashboard's rollback affordance honest for EVERY project,
  // not only those that opted into artifact retention.
  await repos.deployment.setArtifactRetainedAt(newDeployment.id, new Date()).catch((err) => {
    console.error(`[rollback-orchestrator] Failed to mark ${newDeployment.id} retained:`, err);
  });

  try {
    // A running build defers reclamation until its final acknowledgement. The
    // same hook also serves callers that have already completed their worker.
    await reconcileProjectRetention(newDeployment.projectId);
  } catch (err) {
    console.error(
      `[rollback-orchestrator] Prune failed for project ${newDeployment.projectId}:`,
      err,
    );
  }
}

/**
 * Resolve HOW a rollback to this deployment would run, without running it.
 *
 * Shared by `rollback()` and the restore-plan endpoint, so the confirm dialog's
 * copy (instant, registry reacquisition, or source rebuild), the GitHub-access
 * gate and the executor can never disagree about the mode.
 */
export async function resolveRestorePlan(targetDeploymentId: string): Promise<{
  target: Deployment;
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
  plan: RestorePlan;
}> {
  const target = await repos.deployment.findById(targetDeploymentId);
  if (!target) {
    throw new AppError("Deployment not found", 404, "DEPLOYMENT_NOT_FOUND");
  }
  const project = await repos.project.findById(target.projectId);
  if (!project) {
    throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  }

  const serviceImages = await resolveEffectiveServiceImages(target);

  // Ask the host which of the candidate artifacts are actually still there, so a
  // reclaimed tag (or a removed release dir) degrades to a rebuild instead of
  // failing mid-deploy.
  const candidates = new Set<string>();
  for (const row of serviceImages) if (row.imageRef) candidates.add(row.imageRef);
  if (target.imageRef) candidates.add(target.imageRef);
  const staticDir = staticReleaseDir(target);

  let unitRestore = false;
  const presence = new Map<string, boolean>();
  let staticDirPresent = false;
  try {
    const { runtime } = await resolveDeploymentRuntime(target);
    try {
      unitRestore = runtime.supports("unitRestore") && !!runtime.makeActive;
      if (unitRestore && runtime instanceof BareRuntime) {
        unitRestore = await runtime.canRestoreUnit(toRef(target));
      }
      if (runtime instanceof DockerRuntime) {
        for (const ref of candidates) {
          presence.set(ref, await runtime.imageExistsLocally(ref).catch(() => false));
        }
      }
    } finally {
      await runtime.dispose?.();
    }
    if (staticDir) staticDirPresent = await hostPathExists(target, staticDir);
  } catch (err) {
    // Host unreachable / server row gone: we can't prove an artifact is there, so
    // plan a safe non-retained recovery rather than promising an instant restore.
    unitRestore = false;
    console.warn(
      `[rollback] Could not inspect the host for ${target.id}; planning artifact recovery: ${safeErrorMessage(err)}`,
    );
  }

  const plan = planRestore({
    target,
    project,
    unitRestore,
    serviceImages,
    imagePresent: (ref) => presence.get(ref) === true,
    pathPresent: () => staticDirPresent,
  });

  return { target, project, plan };
}

/**
 * What image was each service actually RUNNING in this release?
 *
 * Not simply "this deployment's service rows": a deploy only rebuilds what
 * changed, so an untouched service's row carries its previous image forward, and
 * a smart-deploy `skipped` row may record no image at all. Walking backwards to
 * the last row that named an image is what lets a restore reuse the images
 * already on the host for the services a deploy never touched — the whole point
 * of per-service tracking — instead of rebuilding the entire stack.
 */
async function resolveEffectiveServiceImages(
  target: Deployment,
): Promise<Array<{ serviceName: string | null; imageRef: string | null }>> {
  const rows = await repos.service.listByDeployment(target.id);
  return (await effectiveServiceArtifacts(target, rows)).map((row) => ({
    serviceName: row.serviceName ?? null,
    imageRef: row.imageRef,
  }));
}

/**
 * Does this path exist on the release's OWN host? Static releases only.
 *
 * Must be the right host or the answer is worse than useless: claiming a remote
 * release's files are present because a same-named directory exists locally would
 * plan an instant restore that deploys nothing. So the server executor is used
 * whenever the release records a server, and the local host is consulted ONLY
 * when it recorded none (a desktop/local deploy, where there is no other host).
 */
async function hostPathExists(target: Deployment, path: string): Promise<boolean> {
  const serverId = (target.meta as { serverId?: string } | null)?.serverId;
  const { createExecutor, sharedMountExecutor } = await import("@repo/adapters");
  const { resolveServerExecutor } = await import("../../../lib/deployment-runtime");
  try {
    const { executor, isLocal } = await resolveServerExecutor(serverId, target.organizationId);
    // The static tree is a mount this process shares 1:1 with its host, so on the local
    // box read it directly — the same rule the promote half already uses, and asking the
    // host channel instead let a firewall answer "reclaimed" about a release sitting
    // right there (#490).
    const exec = await sharedMountExecutor({ localHost: isLocal, executor });
    return exec ? await exec.exists(path) : false;
  } catch {
    if (serverId) return false; // a real server we couldn't reach → assume gone, rebuild
    // No server recorded: a desktop/local release, same shared tree.
    return await createExecutor()
      .exists(path)
      .catch(() => false);
  }
}

/**
 * User-triggered rollback. Resolves the plan, then executes it.
 */
export async function rollback(targetDeploymentId: string): Promise<void> {
  const { target, project, plan } = await resolveRestorePlan(targetDeploymentId);

  if (plan.mode === "ineligible") {
    throw new AppError(plan.message, 409, plan.code);
  }
  if (plan.mode === "unit-swap") {
    await withProjectRuntimeLock(project.id, async () => {
      // A cleanup may have won between the preview and this lock.
      const current = await resolveRestorePlan(targetDeploymentId);
      if (current.plan.mode !== "unit-swap") {
        throw new AppError("The retained runtime changed. Retry the rollback to use its current restore plan.", 409, ROLLBACK_ERROR_CODES.ARTIFACT_GONE);
      }
      await restoreViaUnitSwap(current.target, current.project);
      await reconcileProjectRetentionSafe(project.id);
    });
    return;
  }
  await restoreViaRedeploy(target, project, plan);
}

/**
 * Restore by deploying the target's frozen snapshot again, with its retained
 * images pinned (`redeploy-pinned`), a frozen release image pulled again
 * (`reacquire-image`), or source rebuilt from its commit (`rebuild`).
 *
 * Calls `triggerDeployment` (build.service) directly — no cycle: the
 * orchestrator already statically depends on build.service (for
 * checkNoActiveBuild), and build.service does NOT import rollback. The only
 * deploy↔rollback edge is build-pipeline's DYNAMIC import of `onDeploymentReady`.
 */
async function restoreViaRedeploy(
  target: Deployment,
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  plan: Extract<RestorePlan, { mode: "redeploy-pinned" | "reacquire-image" | "rebuild" }>,
): Promise<void> {
  // Where are we rolling back FROM? The currently-active release's commit —
  // recorded so this restore is itself reversible.
  const currentActive = project.activeDeploymentId
    ? await findActiveDeployment(project)
    : null;
  const prevSha = currentActive?.commitSha ?? target.commitShaBefore ?? undefined;

  if (plan.mode === "rebuild" && !target.commitSha) {
    throw new AppError(
      "Rollback target has no commit_sha to check out.",
      409,
      ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
    );
  }

  // Ship the target's CAPTURED config + env verbatim — not a fresh snapshot from
  // the project's current columns / env_var table — so the restore runs exactly
  // what originally ran. `handoverImages` / `handoverAppImage` are the only
  // fields we overwrite: handover fields pin retained artifacts; the reacquire
  // branch reasserts the exact release ref selected from this same snapshot.
  const frozen = (target.meta ?? {}) as DeploymentConfigSnapshot;
  const meta = withoutPinnedArtifacts({ ...frozen });
  if (plan.mode === "redeploy-pinned") {
    if (Object.keys(plan.handoverImages).length > 0) meta.handoverImages = plan.handoverImages;
    if (plan.handoverAppImage) meta.handoverAppImage = plan.handoverAppImage;
    if (plan.handoverStaticDir) meta.handoverStaticDir = plan.handoverStaticDir;
  } else if (plan.mode === "reacquire-image") {
    // Carry the ref selected by the pure plan back onto the cloned snapshot. Do
    // not call the release resolver here: today's project template/source may
    // differ, while this digest is the artifact the target actually ran.
    meta.releaseImageRef = plan.releaseImageRef;
  }
  const replayBranch =
    plan.mode === "reacquire-image"
      ? (typeof meta.branch === "string" && meta.branch.trim()) || target.branch?.trim() || "main"
      : target.branch;

  // Attribute the deploy to an org member so token resolution has an actor; the
  // triggerer is the system.
  const orgMembers = await repos.member
    .listByOrganization(target.organizationId)
    .catch(() => [] as Array<{ userId: string }>);
  const rollbackCtx = buildBackgroundContext({
    userId: orgMembers[0]?.userId ?? "",
    organizationId: target.organizationId,
    label: "rollback:trigger",
  });

  await triggerDeployment(rollbackCtx, {
    projectId: target.projectId,
    // Supplying a concrete frozen/default branch also prevents the generic
    // trigger path from asking today's linked repository for its default branch.
    branch: replayBranch,
    // A release-image reacquisition is intentionally commit-free. Passing even
    // a display-only abbreviated SHA makes triggerDeployment canonicalize it
    // through the project's CURRENT repository, violating rollback isolation.
    commitSha: plan.mode === "reacquire-image" ? undefined : (target.commitSha ?? undefined),
    commitMessage:
      target.commitMessage ??
      (target.commitSha ? `Rollback to ${target.commitSha.slice(0, 7)}` : "Rollback"),
    environment: target.environment,
    trigger: "rollback",
    // A restore brings the WHOLE release back — smart per-service targeting
    // would leave half the stack on the newer version.
    serviceIds: undefined,
    forceAll: true,
    commitShaBefore: prevSha,
    reuseSnapshot: { meta, envVars: (target.envVars as Record<string, string> | null) ?? null },
  });
}

/**
 * Restore a durable unit in place (bare supervisor unit, cloud workspace):
 * swap the runtime, probe that it actually came up, then commit the pointer.
 */
async function restoreViaUnitSwap(
  target: Deployment,
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
): Promise<void> {
  // Guard against racing an in-flight deploy: makeActive fires immediately and
  // the still-building deploy's onDeploymentReady would clobber the swap. The
  // redeploy path gets this for free inside triggerDeployment.
  await checkNoActiveBuild(target.projectId);

  if (!target.artifactRetainedAt) {
    throw new AppError(
      "Rollback artifact is no longer retained for this deployment.",
      409,
      ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
    );
  }

  const { runtime } = await resolveDeploymentRuntime(target);
  const makeActive = runtime.makeActive?.bind(runtime);
  if (!makeActive) {
    await runtime.dispose?.();
    throw new AppError(
      `Runtime "${runtime.name}" cannot restore a unit in place.`,
      409,
      ROLLBACK_ERROR_CODES.UNSUPPORTED_RUNTIME,
    );
  }

  const currentActive =
    (project.activeDeploymentId
      ? await findActiveDeployment(project)
      : null) ?? null;

  try {
    // The primitive handles BOTH halves of the swap: it stops `from` and starts
    // `to`. We don't call runtime.archive() afterwards — that would just stop an
    // already-stopped unit. A restore replays prior state, so the FROZEN
    // snapshot is the right resource source (unlike a redeploy, which re-reads
    // the project).
    const targetResources = (target.meta as DeploymentConfigSnapshot | null)?.resources as
      | ResourceConfig
      | undefined;

    let result;
    try {
      result = await makeActive({
        from: currentActive ? toRef(currentActive) : null,
        to: toRef(target),
        resources: targetResources ?? undefined,
      });
    } catch (err) {
      // The old unit may already be stopped when starting the target fails.
      await revertUnitSwap(runtime, target, currentActive, target.containerId);
      throw err;
    }

    const liveContainerId = result.containerId ?? target.containerId;

    // Health gate: don't point the project at a unit that didn't come up.
    // Runtimes that can't be inspected (bare has no containerInfo) skip this.
    if (liveContainerId && runtime.supports("containerInfo")) {
      const up = await probeRunning(runtime, liveContainerId);
      if (!up) {
        await revertUnitSwap(runtime, target, currentActive, liveContainerId);
        throw new AppError(
          "The restored version didn't come up; the previous version is still serving.",
          409,
          ROLLBACK_ERROR_CODES.NOT_READY,
        );
      }
    }

    // ── DB writes with compensating runtime rollback ──────────────────
    // The runtime has already swapped. Either both DB updates land or we swap
    // back, so the dashboard can never point at a release that isn't serving.
    try {
      if (result.containerId && result.containerId !== target.containerId) {
        await repos.deployment.setContainerId(
          target.id,
          result.containerId,
          result.url ?? undefined,
        );
      }
      // currentActive keeps its `artifact_retained_at` — it's now the
      // restorable previous version.
      await repos.project.setActiveDeployment(target.projectId, target.id);
    } catch (dbErr) {
      console.error(
        `[rollback] DB write failed after unit swap of ${target.id}; swapping back:`,
        dbErr,
      );
      await revertUnitSwap(runtime, target, currentActive, liveContainerId);
      throw dbErr;
    }
  } finally {
    await runtime.dispose?.();
  }

  // Re-register managed (.opsh.io) routes for the restored release — the shared
  // helper the deploy pipeline and the Domains tab use. Best-effort by contract:
  // routing never fails a deploy, and it must not fail a restore either.
  try {
    const { syncProjectManagedEdge } = await import("../../projects/project-runtime.service");
    const refreshed = await repos.project.findById(target.projectId);
    if (refreshed) {
      await syncProjectManagedEdge(refreshed, target.organizationId, { markOnFailure: true });
    }
  } catch (err) {
    console.warn(`[rollback] Managed edge sync after restore of ${target.id} failed:`, err);
  }
}

/** Poll until the unit reports running. Short by design — this gates the
 *  pointer flip, it isn't a readiness check for the app's own traffic. */
async function probeRunning(
  runtime: Awaited<ReturnType<typeof resolveDeploymentRuntime>>["runtime"],
  containerId: string,
  attempts = 10,
  intervalMs = 1_000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const info = await runtime.getContainerInfo(containerId).catch(() => null);
    if (info?.status === "running") return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Put the previous release back after a failed swap. Best-effort — a failure
 *  here is the one case that needs a human, so it's logged loudly. */
async function revertUnitSwap(
  runtime: Awaited<ReturnType<typeof resolveDeploymentRuntime>>["runtime"],
  target: Deployment,
  currentActive: Deployment | null,
  liveContainerId: string | null,
): Promise<void> {
  try {
    if (currentActive) {
      await runtime.makeActive?.({
        // The target may now be running under a different id than the row
        // records; use whatever is live.
        from: { ...toRef(target), containerId: liveContainerId },
        to: toRef(currentActive),
        resources: (currentActive.meta as DeploymentConfigSnapshot | null)?.resources as
          | ResourceConfig
          | undefined,
      });
    } else {
      // We promoted into an empty slot; the best we can do is stop it again.
      await runtime.archive({ ...toRef(target), containerId: liveContainerId });
    }
  } catch (err) {
    console.error(
      `[rollback] CRITICAL: could not restore the previous release after a failed swap of ${target.id}. ` +
        `The runtime may be serving ${liveContainerId ?? "nothing"} while the DB records ${currentActive?.id ?? "no active release"}. Manual reconciliation required.`,
      err,
    );
  }
}

/**
 * Enforce retention: releases beyond `resolveRollbackWindow(project)` get their
 * artifacts purged unless pinned. The active release is never purged.
 *
 * Called after every successful deploy, and exposed for admin tooling.
 */
export async function prune(projectId: string): Promise<{ purged: number; failed: number }> {
  return await withRetentionLock(projectId, pruneUnlocked) ?? { purged: 0, failed: 0 };
}

async function pruneUnlocked(project: Project): Promise<{ purged: number; failed: number }> {
  const keep = await retainedArtifacts(project);
  let purged = 0;
  let failed = 0;
  for (const dep of keep.overflow) {
    try {
      // Read the complete inventory before any deletion. Losing the query must
      // never look like a release without services and clear its retry marker.
      const serviceRows = await effectiveServiceArtifacts(dep, await repos.service.listByDeployment(dep.id));
      const { runtime } = await resolveDeploymentRuntime(dep);
      try {
        const ref = toRef(dep);
        const container = usableRef(ref.containerId);
        const image = usableRef(ref.imageRef);
        const sharedUnit = container && keep.containers.has(container) &&
          (runtime.supports("unitRestore") || isArtifactRef(container));
        if (runtime.supports("rollback") && !sharedUnit) {
          await runtime.purge({
            ...ref,
            containerId: container && !keep.containers.has(container) ? container : null,
            imageRef: image && !keep.images.has(image) ? image : null,
          });
        }
        let serviceFailure: unknown = null;
        for (const row of serviceRows) {
          try {
            const serviceImage = usableRef(row.imageRef);
            const serviceContainer = usableRef(row.containerId);
            if (isArtifactRef(serviceImage) && !keep.images.has(serviceImage!)) {
              await runtime.destroy(serviceImage!);
            }
            if (runtime instanceof DockerRuntime) {
              // Compose's deployment row is a sentinel; its per-service images
              // and containers are the actual artifacts. Reclaim them before
              // clearing the row, using the same protection as single apps.
              await runtime.purge({
                id: dep.id,
                projectId: dep.projectId,
                containerId: serviceContainer && !keep.containers.has(serviceContainer) &&
                  serviceContainer !== serviceImage ? serviceContainer : null,
                imageRef: serviceImage && !isArtifactRef(serviceImage) &&
                  !keep.images.has(serviceImage) ? serviceImage : null,
              });
            }
          } catch (err) {
            serviceFailure ??= err;
          }
        }
        if (serviceFailure) throw serviceFailure;
      } finally {
        await runtime.dispose?.();
      }
      await repos.deployment.setArtifactRetainedAt(dep.id, null);
      purged += 1;
    } catch (err) {
      failed += 1;
      console.error(`[rollback-orchestrator] Failed to purge ${dep.id}:`, err);
    }
  }
  if (purged > 0) console.log(`[rollback-orchestrator] project ${project.id}: reclaimed artifacts for ${purged} past release(s)`);
  return { purged, failed };
}

/** Reconcile the row, its artifacts, and leftover build tags under one lock.
 * Used by deploy completion, settings, unpinning, and the scheduled backstop. */
export async function reconcileProjectRetention(projectId: string) {
  return await withRetentionLock(projectId, async (project) => {
    const result = await pruneUnlocked(project);
    // A failed purge keeps its retry marker; don't let a second collector
    // remove more of that release while its cleanup is incomplete.
    if (result.failed) return { purged: result.purged, removed: 0, bytes: 0, skippedInUse: 0, errors: result.failed };
    const { reapProjectImages } = await import("../image-gc");
    return { ...await reapProjectImages(project), purged: result.purged };
  }) ?? { purged: 0, removed: 0, bytes: 0, skippedInUse: 0, errors: 0 };
}

export async function reconcileProjectRetentionSafe(projectId: string): Promise<void> {
  try {
    await reconcileProjectRetention(projectId);
  } catch (err) {
    console.error(`[rollback-orchestrator] Cleanup deferred for ${projectId}:`, err);
  }
}

/**
 * Cap on pinned deployments per project. Bounds disk usage. Today
 * hardcoded; could be moved to instance_settings later.
 */
const MAX_PINNED_PER_PROJECT = 10;

export const PIN_ERROR_CODES = {
  LIMIT_REACHED: "PIN_LIMIT_REACHED",
  NOT_READY: "PIN_NOT_READY",
  ARTIFACT_GONE: "PIN_ARTIFACT_GONE",
} as const;

export async function setPin(deploymentId: string, pinned: boolean): Promise<void> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) {
    throw new AppError("Deployment not found", 404, "DEPLOYMENT_NOT_FOUND");
  }
  return withProjectRuntimeLock(dep.projectId, () => setPinUnlocked(deploymentId, pinned));
}

async function setPinUnlocked(deploymentId: string, pinned: boolean): Promise<void> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new AppError("Deployment not found", 404, "DEPLOYMENT_NOT_FOUND");
  if (dep.pinned === pinned) return;

  if (pinned) {
    if (dep.status !== "ready" && dep.status !== "partial_failure") {
      throw new AppError(
        "Only successful deployments can be pinned.",
        409,
        PIN_ERROR_CODES.NOT_READY,
      );
    }
    if (!dep.artifactRetainedAt) {
      throw new AppError(
        "Cannot pin: rollback artifact is no longer retained for this deployment.",
        409,
        PIN_ERROR_CODES.ARTIFACT_GONE,
      );
    }
    const current = await repos.deployment.countPinned(dep.projectId);
    if (current >= MAX_PINNED_PER_PROJECT) {
      throw new AppError(
        `Pin limit reached (${MAX_PINNED_PER_PROJECT}). Unpin an older deployment first.`,
        409,
        PIN_ERROR_CODES.LIMIT_REACHED,
      );
    }
  }

  await repos.deployment.setPinned(deploymentId, pinned);
  if (!pinned) await reconcileProjectRetentionSafe(dep.projectId);
}
