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
 *      disk-sized auto window, else the instance default). Pinned releases are
 *      exempt and don't consume the budget.
 *
 * ── Restore ──────────────────────────────────────────────────────────────
 *
 * `rollback(id)` asks `planRestore` how this particular release can come back
 * (see restore-plan.ts for the three modes and why), then executes:
 *
 *   redeploy-pinned / rebuild → ONE `triggerDeployment` call carrying the
 *     target's frozen config + env, with its images pinned when they're still
 *     on the host. A restore is a real deployment: it gets the deploy pipeline's
 *     env, ports, volumes, labels, network, routing, health gate and
 *     stabilization watch for free, its own logs and SSE stream, and — because
 *     `onSuccess` reuses the version number for a commit — rolling back to v2
 *     shows up as v2 again. The active pointer only ever moves FORWARD on
 *     success, so a failed restore leaves the current release serving.
 *
 *   unit-swap → `runtime.makeActive`, then probe and commit the pointer, with
 *     a compensating swap-back if the DB write fails.
 *
 * A restore is itself restorable: it records the release it moved away from as
 * `commit_sha_before`.
 */

import { repos, type Deployment, type Project } from "@repo/db";
import { DockerRuntime, type DeploymentRef, type ResourceConfig } from "@repo/adapters";
import { AppError, safeErrorMessage } from "@repo/core";
import { resolveDeploymentRuntime } from "../../../lib/deployment-runtime";
import { resolveRollbackWindow } from "../release-retention";
import {
  checkNoActiveBuild,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "../build.service";
import { buildBackgroundContext } from "../../../lib/request-context";
import { computeKeepSet } from "../image-gc";
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
 * window, then reclaims superseded images.
 *
 * Idempotent. Every step is best-effort: the new deployment is already live and
 * a bookkeeping failure must never roll it back.
 */
export async function onDeploymentReady(opts: {
  newDeployment: Deployment;
  previousActive: Deployment | null;
}): Promise<void> {
  const { newDeployment, previousActive } = opts;
  const project = await repos.project.findById(newDeployment.projectId).catch(() => null);

  if (previousActive && previousActive.id !== newDeployment.id) {
    try {
      // Only a durable-unit runtime has something to stop-and-keep, and only
      // when the project wants artifacts held. Docker's artifact is the image
      // (retained by the keep set) and its container is already gone.
      if (project && shouldRetainArtifact(project)) {
        const { runtime } = await resolveDeploymentRuntime(previousActive);
        try {
          if (runtime.supports("unitRestore") && runtime.makeActive) {
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
    await prune(newDeployment.projectId);
  } catch (err) {
    console.error(
      `[rollback-orchestrator] Prune failed for project ${newDeployment.projectId}:`,
      err,
    );
  }

  // Reclaim this project's superseded BUILT IMAGES now (the immediate "remove the
  // old image on redeploy" cleanup), keeping the rollback-window keep-set so
  // restores still work, and re-measure the snapshot size / auto window while
  // we're already talking to the host. Never throws — the daily images:gc job is
  // the backstop.
  const { reapProjectImagesSafe } = await import("../image-gc");
  await reapProjectImagesSafe(newDeployment.projectId);
}

/**
 * Resolve HOW a rollback to this deployment would run, without running it.
 *
 * Shared by `rollback()` and the restore-plan endpoint, so the confirm dialog's
 * copy ("instant" vs "rebuild"), the GitHub-access gate and the executor can
 * never disagree about the mode.
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
    // plan the safe branch (rebuild) rather than promising an instant restore.
    console.warn(
      `[rollback] Could not inspect the host for ${target.id}; planning a rebuild: ${safeErrorMessage(err)}`,
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
  const rows = await repos.service.listByDeployment(target.id).catch(() => []);
  if (rows.length === 0) return [];

  const missing = rows.filter((row) => !row.imageRef);
  if (missing.length === 0) {
    return rows.map((row) => ({ serviceName: row.serviceName, imageRef: row.imageRef }));
  }

  const asOf = await repos.serviceDeployment
    .effectiveImagesAsOf(target.projectId, target.createdAt)
    .catch(() => new Map<string, { imageRef: string; serviceName: string | null }>());

  return rows.map((row) => ({
    serviceName: row.serviceName ?? asOf.get(row.serviceId)?.serviceName ?? null,
    imageRef: row.imageRef ?? asOf.get(row.serviceId)?.imageRef ?? null,
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
  const { resolveServerExecutor } = await import("../../../lib/deployment-runtime");
  try {
    const { executor } = await resolveServerExecutor(serverId, target.organizationId);
    return await executor.exists(path);
  } catch (err) {
    if (serverId) return false; // a real server we couldn't reach → assume gone, rebuild
    try {
      const { createHostExecutor } = await import("@repo/adapters");
      return await createHostExecutor().exists(path);
    } catch {
      void err;
      return false;
    }
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
    await restoreViaUnitSwap(target, project);
    return;
  }
  await restoreViaRedeploy(target, project, plan);
}

/**
 * Restore by deploying the target's frozen snapshot again, with its retained
 * images pinned (`redeploy-pinned`) or rebuilt from its commit (`rebuild`).
 *
 * Calls `triggerDeployment` (build.service) directly — no cycle: the
 * orchestrator already statically depends on build.service (for
 * checkNoActiveBuild), and build.service does NOT import rollback. The only
 * deploy↔rollback edge is build-pipeline's DYNAMIC import of `onDeploymentReady`.
 */
async function restoreViaRedeploy(
  target: Deployment,
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  plan: Extract<RestorePlan, { mode: "redeploy-pinned" | "rebuild" }>,
): Promise<void> {
  // Where are we rolling back FROM? The currently-active release's commit —
  // recorded so this restore is itself reversible.
  const currentActive = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
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
  // fields we overwrite: they pin the retained artifacts so the deploy skips the
  // build (and, when everything is pinned, the clone and git token too).
  const frozen = (target.meta ?? {}) as DeploymentConfigSnapshot;
  const meta = withoutPinnedArtifacts({ ...frozen });
  if (plan.mode === "redeploy-pinned") {
    if (Object.keys(plan.handoverImages).length > 0) meta.handoverImages = plan.handoverImages;
    if (plan.handoverAppImage) meta.handoverAppImage = plan.handoverAppImage;
    if (plan.handoverStaticDir) meta.handoverStaticDir = plan.handoverStaticDir;
  }

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
    branch: target.branch,
    commitSha: target.commitSha ?? undefined,
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
      ? await repos.deployment.findById(project.activeDeploymentId)
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

    const result = await makeActive({
      from: currentActive ? toRef(currentActive) : null,
      to: toRef(target),
      resources: targetResources ?? undefined,
    });

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
export async function prune(projectId: string): Promise<{ purged: number }> {
  const project = await repos.project.findById(projectId);
  if (!project) return { purged: 0 };

  const rollbackWindow = await resolveRollbackWindow(project);
  // Newest first. Within the window we keep; beyond it we purge unless pinned.
  const ready = await repos.deployment.listReadyOrderedDesc(projectId);

  const overflow: Deployment[] = [];
  let unpinnedRetained = 0;
  for (const dep of ready) {
    // Never purge the active release, regardless of position.
    if (dep.id === project.activeDeploymentId) continue;
    // Pinned releases are exempt AND don't consume the window budget.
    if (dep.pinned) continue;
    if (unpinnedRetained < rollbackWindow) {
      unpinnedRetained += 1;
      continue;
    }
    if (dep.artifactRetainedAt) overflow.push(dep);
  }

  if (overflow.length === 0) return { purged: 0 };

  // A restore reuses its source release's image tag, so two rows legitimately
  // point at one image. Purging by row would then delete an image another
  // retained release (possibly the ACTIVE one) still needs — so consult the
  // same keep set the image GC uses and never remove a tag that's still in it.
  const keep = await computeKeepSet(project).catch(() => new Set<string>());
  let purged = 0;

  for (const dep of overflow) {
    try {
      const { runtime } = await resolveDeploymentRuntime(dep);
      try {
        if (runtime.supports("rollback")) {
          const ref = toRef(dep);
          await runtime.purge({
            ...ref,
            imageRef: ref.imageRef && keep.has(ref.imageRef) ? null : ref.imageRef,
          });
        }
      } finally {
        await runtime.dispose?.();
      }
      await repos.deployment.setArtifactRetainedAt(dep.id, null);
      purged += 1;
    } catch (err) {
      console.error(`[rollback-orchestrator] Failed to purge ${dep.id}:`, err);
    }
  }

  return { purged };
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

export async function setPin(
  deploymentId: string,
  pinned: boolean,
): Promise<void> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) {
    throw new AppError("Deployment not found", 404, "DEPLOYMENT_NOT_FOUND");
  }

  if (pinned) {
    if (dep.status !== "ready") {
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
}
