/**
 * Built-image garbage collector.
 *
 * Every build mints a globally-unique tag (`openship/<slug>-<svc>:bld_..-svc_..`)
 * so a redeploy never overwrites the prior image — without a sweep, each deploy
 * server accumulates old builds (and dangling layers) forever. This reconciles
 * the images ACTUALLY on each host against the DB keep-set and prunes the rest.
 *
 * Safety model (see the audit): the ONLY images considered are those carrying
 * the `openship.project=<id>` label, which `labels()` stamps on FINAL build
 * images — base/third-party images (postgres, redis, mongo, …) are PULLED, never
 * labeled, and are therefore structurally unreachable here. The keep-set is the
 * exact imageRef of the active + pinned + newest-`rollbackWindow` deployments
 * (per deployment AND per compose service), so an in-use / rollback-target image
 * is never a candidate; the daemon's in-use 409 is a further backstop.
 *
 * Scheduled as the `images:gc` system job (see modules/jobs/job.registry.ts).
 */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos, type Project } from "@repo/db";
import { DockerRuntime, ownsBuiltImage } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { refreshRollbackCapacity } from "./release-retention";
import { computeKeepSet } from "./retained-artifacts";
import { withRetentionLock } from "./retention-lock";

export interface ImageGcSummary {
  projectsScanned: number;
  releasesPurged: number;
  imagesRemoved: number;
  bytesReclaimed: number;
  skippedInUse: number;
  errors: number;
}

// The policy/inventory is shared with artifact pruning and explicit teardown.
export { computeKeepSet } from "./retained-artifacts";

export interface ReapResult {
  removed: number;
  bytes: number;
  skippedInUse: number;
  errors: number;
}

/**
 * Decide what to remove for ONE listed (label-scoped) image — the safety-
 * critical selection, kept pure + unit-tested so "never ruin an operator's
 * image" is verifiable:
 *   - an image id in the keep-set → keep the whole image (`[]`).
 *   - has managed build tags → return only the expired tags, keeping retained
 *     aliases even when they share the same image id. We untag only what we own, so
 *     Docker deletes the image when our last tag is gone. Removing by these tags
 *     (not the image id) can never yank a foreign tag the operator added.
 *   - truly dangling (NO tags at all) → the image id: our superseded, untagged
 *     final layer, safe to drop.
 *   - only foreign or retained tags remain → keep.
 */
export function selectImageRemovalRefs(
  img: { id: string; repoTags: string[] },
  keep: Set<string>,
): string[] {
  if (keep.has(img.id)) return [];
  const ownTags = img.repoTags.filter((t) => ownsBuiltImage(t) && !keep.has(t));
  if (ownTags.length > 0) return ownTags;
  if (img.repoTags.length === 0) return [img.id];
  return []; // only foreign tags → never touch
}

/**
 * Reclaim one project's superseded built images on its own deploy host, keeping
 * the rollback-window keep-set. Called by retention reconciliation after a
 * worker finishes, a limit changes, or the daily backstop runs. Includes Cloud
 * Docker hosts; runtimes without Docker images have nothing to reap here.
 *
 * Observable, never a black box: every non-empty reclaim logs a single line with
 * the project id + counts + bytes, and the counts roll up into the images:gc
 * job_run summary. Rollback/backup artifacts are untouched — the keep-set retains
 * every rollback-eligible image, and volumes/backups aren't images.
 */
export async function reapProjectImages(project: Project): Promise<ReapResult> {
  return await withRetentionLock(project.id, reapProjectImagesUnlocked)
    ?? { removed: 0, bytes: 0, skippedInUse: 0, errors: 0 };
}

async function reapProjectImagesUnlocked(project: Project): Promise<ReapResult> {
  const out: ReapResult = { removed: 0, bytes: 0, skippedInUse: 0, errors: 0 };
  if (!project.activeDeploymentId) return out; // no host to resolve
  const activeDep = await findActiveDeployment(project);
  if (!activeDep) return out;

  const { runtime } = await resolveDeploymentRuntime(activeDep);
  try {
    if (!(runtime instanceof DockerRuntime)) return out;
    const keep = await computeKeepSet(project);
    const images = await runtime.listProjectImages(project.id);
    for (const img of images) {
      const refs = selectImageRemovalRefs(img, keep);
      if (refs.length === 0) continue; // kept, or operator-repurposed → leave it
      try {
        for (const ref of refs) await runtime.removeImage(ref);
        out.removed += 1;
        if (refs.length === img.repoTags.length || img.repoTags.length === 0) out.bytes += img.size;
      } catch (err) {
        if ((err as { statusCode?: number } | null)?.statusCode === 409) {
          out.skippedInUse += 1;
        } else {
          out.errors += 1;
          console.error(`[image-gc] project ${project.id}: image removal failed: ${safeErrorMessage(err)}`);
        }
      }
    }
    // Reclaim this project's untagged (superseded final) layers too.
    await runtime.pruneProjectDanglingImages(project.id);

    await refreshRollbackCapacity({
      projectId: project.id,
      imageSizes: images.filter((img) => img.repoTags.some(ownsBuiltImage)).map((img) => img.size),
    });
  } finally {
    await runtime.dispose?.();
  }
  if (out.removed > 0 || out.skippedInUse > 0) {
    console.log(
      `[image-gc] project ${project.id}: removed ${out.removed} image(s), ` +
        `${(out.bytes / 1e9).toFixed(2)} GB reclaimed, ${out.skippedInUse} kept (in use)`,
    );
  }
  return out;
}

/**
 * Best-effort image reclaim for the deploy HOT PATHS — NEVER throws, so a GC
 * hiccup can't fail a deploy. Accepts a Project or a projectId (loaded here) and
 * routes warnings to `onWarn` (e.g. the BuildLogger) or console by default.
 *
 * The normal deployment/settings lifecycle uses reconcileProjectRetentionSafe,
 * which also updates release markers and purges non-image artifacts.
 */
export async function reapProjectImagesSafe(
  projectOrId: Project | string,
  onWarn?: (msg: string) => void,
): Promise<void> {
  const id = typeof projectOrId === "string" ? projectOrId : projectOrId.id;
  try {
    const project =
      typeof projectOrId === "string" ? await repos.project.findById(projectOrId) : projectOrId;
    if (project) await reapProjectImages(project);
  } catch (err) {
    const msg = `[image-gc] reclaim skipped for project ${id}: ${safeErrorMessage(err)}`;
    if (onWarn) onWarn(msg);
    else console.error(msg);
  }
}

/**
 * Sweep every project's built images. Per-project failures (unreachable host,
 * daemon down) are counted and skipped — never fatal to the sweep.
 */
export async function runImageGcSweep(): Promise<ImageGcSummary> {
  const summary: ImageGcSummary = {
    projectsScanned: 0,
    releasesPurged: 0,
    imagesRemoved: 0,
    bytesReclaimed: 0,
    skippedInUse: 0,
    errors: 0,
  };
  const projects = await repos.project.listAllForScan();
  for (const project of projects) {
    summary.projectsScanned += 1;
    try {
      // Retry the complete artifact lifecycle too: image-only sweeps left
      // snapshot badges and static/cloud artifacts behind after a failed prune.
      const { reconcileProjectRetention } = await import("./rollback/rollback-orchestrator");
      const r = await reconcileProjectRetention(project.id);
      summary.imagesRemoved += r.removed;
      summary.releasesPurged += r.purged;
      summary.bytesReclaimed += r.bytes;
      summary.skippedInUse += r.skippedInUse;
      summary.errors += r.errors;
    } catch (err) {
      summary.errors += 1;
      console.error(`[image-gc] project ${project.id} sweep failed:`, safeErrorMessage(err));
    }
  }
  return summary;
}
