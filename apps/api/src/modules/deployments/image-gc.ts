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

import { repos, type Deployment, type Project } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import { normalizeRollbackWindow, safeErrorMessage } from "@repo/core";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { getHostDisk } from "../../lib/host-disk";
import {
  refreshRollbackCapacity,
  resolveRollbackWindow,
  type RollbackWindowProject,
} from "./release-retention";

export interface ImageGcSummary {
  projectsScanned: number;
  imagesRemoved: number;
  bytesReclaimed: number;
  skippedInUse: number;
  errors: number;
}

/**
 * imageRefs to KEEP for a project: every image referenced by the active
 * deployment, all pinned deployments, and the newest `rollbackWindow` ready
 * deployments — collected at BOTH the deployment level (`dep.imageRef`,
 * single-app) and the per-service level (`serviceDeployment.imageRef`, compose).
 * Because each retained deployment contributes all of its services' images, a
 * compose service naturally keeps `rollbackWindow` of ITS builds.
 *
 * Exported for unit testing; pure given the injected loaders.
 */
export async function computeKeepSet(
  project: Pick<Project, "id" | "activeDeploymentId"> & RollbackWindowProject,
  loaders?: {
    listReadyOrderedDesc?: (projectId: string) => Promise<Deployment[]>;
    findById?: (id: string) => Promise<Deployment | undefined>;
    listByDeployment?: (depId: string) => Promise<Array<{ imageRef: string | null }>>;
  },
): Promise<Set<string>> {
  const listReady = loaders?.listReadyOrderedDesc ?? ((id: string) => repos.deployment.listReadyOrderedDesc(id));
  const findById = loaders?.findById ?? ((id: string) => repos.deployment.findById(id));
  const listSds = loaders?.listByDeployment ?? ((id: string) => repos.service.listByDeployment(id));

  const keep = new Set<string>();
  const window = await resolveRollbackWindow(project);
  const ready = await listReady(project.id); // newest first

  const keepDeployments: Deployment[] = [];
  let unpinnedKept = 0;
  for (const dep of ready) {
    if (dep.id === project.activeDeploymentId || dep.pinned) {
      keepDeployments.push(dep);
      continue;
    }
    if (unpinnedKept < window) {
      unpinnedKept += 1;
      keepDeployments.push(dep);
    }
    // else: beyond the window and unpinned → its images are prune candidates.
  }
  // The active deployment is kept even if it isn't in the ready list (e.g. still
  // "reconciling" after a connection-loss deploy).
  if (
    project.activeDeploymentId &&
    !keepDeployments.some((d) => d.id === project.activeDeploymentId)
  ) {
    const active = await findById(project.activeDeploymentId);
    if (active) keepDeployments.push(active);
  }

  for (const dep of keepDeployments) {
    if (dep.imageRef) keep.add(dep.imageRef);
    const sds = await listSds(dep.id);
    for (const sd of sds) if (sd.imageRef) keep.add(sd.imageRef);
  }
  return keep;
}

export interface ReapResult {
  removed: number;
  bytes: number;
  skippedInUse: number;
}

/**
 * Feed the auto-sized rollback window: mean built-image size for this project +
 * free disk where the daemon stores images. Uses the images this sweep already
 * listed and the CACHED disk probe, so a burst of deploys costs one `df`.
 * Best-effort — an unmeasured project simply falls back to the instance default.
 */
async function refreshRollbackCapacityFor(
  project: Project,
  images: Array<{ repoTags: string[]; size: number }>,
): Promise<void> {
  // Only OUR build images estimate a release's size; a project that has never
  // built anything (pure registry-image compose stack) has no snapshot cost.
  const sizes = images
    .filter((img) => img.repoTags.some((t) => t.startsWith("openship/")))
    .map((img) => img.size);
  if (sizes.length === 0) return;

  const activeDep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  const serverId = (activeDep?.meta as { serverId?: string } | null)?.serverId;
  const disk = await getHostDisk(serverId, project.organizationId).catch(() => null);
  const settings = await repos.instanceSettings.get().catch(() => null);

  await refreshRollbackCapacity({
    projectId: project.id,
    imageSizes: sizes,
    diskFreeBytes: disk?.freeBytes ?? null,
    instanceDefault: normalizeRollbackWindow(settings?.defaultRollbackWindow),
  });
}

/**
 * Decide what to remove for ONE listed (label-scoped) image — the safety-
 * critical selection, kept pure + unit-tested so "never ruin an operator's
 * image" is verifiable:
 *   - in the keep-set (active/pinned/rollback-window) → keep (`[]`).
 *   - has `openship/…` tags → return THOSE tags: we untag only what we own, so
 *     Docker deletes the image when our last tag is gone. Removing by these tags
 *     (not the image id) can never yank a foreign tag the operator added.
 *   - truly dangling (NO tags at all) → the image id: our superseded, untagged
 *     final layer, safe to drop.
 *   - only NON-openship tags remain → the operator re-purposed this image → keep.
 */
export function selectImageRemovalRefs(
  img: { id: string; repoTags: string[] },
  keep: Set<string>,
): string[] {
  if (img.repoTags.some((t) => keep.has(t))) return [];
  const ownTags = img.repoTags.filter((t) => t.startsWith("openship/"));
  if (ownTags.length > 0) return ownTags;
  if (img.repoTags.length === 0) return [img.id];
  return []; // only foreign tags → never touch
}

/**
 * Reclaim one project's superseded built images on its own deploy host, keeping
 * the rollback-window keep-set. Called at REDEPLOY (onDeploymentReady, immediate)
 * and from the daily sweep (backstop). No-op for a project that never deployed
 * or whose runtime isn't Docker (cloud/bare have no local image accumulation).
 *
 * Observable, never a black box: every non-empty reclaim logs a single line with
 * the project id + counts + bytes, and the counts roll up into the images:gc
 * job_run summary. Rollback/backup artifacts are untouched — the keep-set retains
 * every rollback-eligible image, and volumes/backups aren't images.
 */
export async function reapProjectImages(project: Project): Promise<ReapResult> {
  const out: ReapResult = { removed: 0, bytes: 0, skippedInUse: 0 };
  if (!project.activeDeploymentId) return out; // no host to resolve
  const activeDep = await repos.deployment.findById(project.activeDeploymentId);
  if (!activeDep) return out;

  const { runtime } = await resolveDeploymentRuntime(activeDep);
  try {
    if (!(runtime instanceof DockerRuntime)) return out; // cloud/bare — nothing local
    const keep = await computeKeepSet(project);
    const images = await runtime.listProjectImages(project.id);
    for (const img of images) {
      const refs = selectImageRemovalRefs(img, keep);
      if (refs.length === 0) continue; // kept, or operator-repurposed → leave it
      try {
        for (const ref of refs) await runtime.removeImage(ref);
        out.removed += 1;
        out.bytes += img.size;
      } catch {
        // removeImage swallows not-found and re-throws everything else — an
        // in-use 409 (a container still references it) lands here. Treat as
        // "keep" and move on; never abort the sweep for one stuck image.
        out.skippedInUse += 1;
      }
    }
    // Reclaim this project's untagged (superseded final) layers too.
    await runtime.pruneProjectDanglingImages(project.id);

    // Re-measure the AUTO rollback window while we're here: we already have this
    // project's image sizes, and host capacity is cached, so retention stays
    // sized to the disk without prune or the wizard ever probing anything.
    await refreshRollbackCapacityFor(project, images).catch(() => {});
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
 * One caller today: `onDeploymentReady` (rollback-orchestrator), which runs after
 * every successful deploy regardless of rollback strategy — the strategy decides
 * how many releases `computeKeepSet` protects, not whether the reclaim happens.
 * The daily `images:gc` job is the backstop for anything this misses.
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
    imagesRemoved: 0,
    bytesReclaimed: 0,
    skippedInUse: 0,
    errors: 0,
  };
  const projects = await repos.project.listAllForScan();
  for (const project of projects) {
    summary.projectsScanned += 1;
    try {
      const r = await reapProjectImages(project);
      summary.imagesRemoved += r.removed;
      summary.bytesReclaimed += r.bytes;
      summary.skippedInUse += r.skippedInUse;
    } catch (err) {
      summary.errors += 1;
      console.error(`[image-gc] project ${project.id} sweep failed:`, safeErrorMessage(err));
    }
  }
  return summary;
}
