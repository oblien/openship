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
 *
 * Every decision goes through ONE classifier (`classifyImage`) that also names
 * its reason, so the same rules power the sweep AND a read-only plan
 * (`planImageGc`) an operator can read before trusting the job with a full disk
 * (#779): what is on each host, what would go, and why the rest stays.
 */

import { repos, type Deployment, type Project } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import { ValidationError, normalizeRollbackWindow, safeErrorMessage } from "@repo/core";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { getHostDisk } from "../../lib/host-disk";
import {
  refreshRollbackCapacity,
  resolveRollbackWindowDetail,
  type RollbackWindowProject,
  type RollbackWindowSource,
} from "./release-retention";

export const IMAGE_GC_JOB_KEY = "images:gc";

export interface ImageGcSummary {
  projectsScanned: number;
  imagesRemoved: number;
  bytesReclaimed: number;
  skippedInUse: number;
  errors: number;
}

export interface ImageGcOptions {
  /**
   * Only remove a superseded image once it is at least this old. The filter can
   * only make a sweep MORE conservative: a younger image is kept, an older one is
   * still removed only when nothing else protects it (active / pinned / rollback
   * window / in use are never overridden by age).
   */
  minAgeMs?: number;
}

/** The summary shape the `images:gc` job row records — one place, so the
 *  scheduled tick and a manual run read the same in job history. */
export function imageGcJobSummary(r: ImageGcSummary): Record<string, number> {
  return {
    scanned: r.projectsScanned,
    removed: r.imagesRemoved,
    bytesReclaimed: r.bytesReclaimed,
    skipped: r.skippedInUse,
    failed: r.errors,
  };
}

// ─── Age filter ──────────────────────────────────────────────────────────────

const AGE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * `30d`, `12h`, `2w`, `90m`, or a bare number of days → milliseconds. Rejects
 * zero and anything else: a filter that parses to "no filter" would silently
 * run the full sweep the operator was trying to narrow.
 */
export function parseMinAge(input: string): number {
  const m = /^(\d+)\s*([mhdw])?$/i.exec(input.trim());
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) {
    throw new ValidationError(
      `Invalid age "${input}" — use a positive number with a unit, e.g. 30d, 12h, 2w`,
    );
  }
  return n * AGE_UNIT_MS[(m[2] ?? "d").toLowerCase()]!;
}

// ─── Keep-set ────────────────────────────────────────────────────────────────

export type KeepReason = "active" | "pinned" | "rollback-window";

/** When one ref is protected for several reasons, report the strongest. */
const KEEP_PRIORITY: Record<KeepReason, number> = { active: 0, pinned: 1, "rollback-window": 2 };

export interface KeepSetLoaders {
  listReadyOrderedDesc?: (projectId: string) => Promise<Deployment[]>;
  findById?: (id: string) => Promise<Deployment | undefined>;
  listByDeployment?: (depId: string) => Promise<Array<{ imageRef: string | null }>>;
}

/**
 * imageRefs to KEEP for a project, each with WHY: every image referenced by the
 * active deployment, all pinned deployments, and the newest `rollbackWindow`
 * ready deployments — collected at BOTH the deployment level (`dep.imageRef`,
 * single-app) and the per-service level (`serviceDeployment.imageRef`, compose).
 * Because each retained deployment contributes all of its services' images, a
 * compose service naturally keeps `rollbackWindow` of ITS builds.
 *
 * Exported for unit testing; pure given the injected loaders.
 */
export async function computeKeepSetDetail(
  project: Pick<Project, "id" | "activeDeploymentId"> & RollbackWindowProject,
  loaders?: KeepSetLoaders,
): Promise<Map<string, KeepReason>> {
  const listReady =
    loaders?.listReadyOrderedDesc ?? ((id: string) => repos.deployment.listReadyOrderedDesc(id));
  const findById = loaders?.findById ?? ((id: string) => repos.deployment.findById(id));
  const listSds = loaders?.listByDeployment ?? ((id: string) => repos.service.listByDeployment(id));

  const { window } = await resolveRollbackWindowDetail(project);
  const ready = await listReady(project.id); // newest first

  const keepDeployments: Array<{ dep: Deployment; reason: KeepReason }> = [];
  let unpinnedKept = 0;
  for (const dep of ready) {
    if (dep.id === project.activeDeploymentId) {
      keepDeployments.push({ dep, reason: "active" });
      continue;
    }
    if (dep.pinned) {
      keepDeployments.push({ dep, reason: "pinned" });
      continue;
    }
    if (unpinnedKept < window) {
      unpinnedKept += 1;
      keepDeployments.push({ dep, reason: "rollback-window" });
    }
    // else: beyond the window and unpinned → its images are prune candidates.
  }
  // The active deployment is kept even if it isn't in the ready list (e.g. still
  // "reconciling" after a connection-loss deploy).
  if (
    project.activeDeploymentId &&
    !keepDeployments.some((k) => k.dep.id === project.activeDeploymentId)
  ) {
    const active = await findById(project.activeDeploymentId);
    if (active) keepDeployments.push({ dep: active, reason: "active" });
  }

  const keep = new Map<string, KeepReason>();
  const add = (ref: string | null, reason: KeepReason) => {
    if (!ref) return;
    const prior = keep.get(ref);
    if (prior === undefined || KEEP_PRIORITY[reason] < KEEP_PRIORITY[prior]) keep.set(ref, reason);
  };
  for (const { dep, reason } of keepDeployments) {
    add(dep.imageRef, reason);
    const sds = await listSds(dep.id);
    for (const sd of sds) add(sd.imageRef, reason);
  }
  return keep;
}

/** The keep-set without reasons — what the sweep's callers historically read. */
export async function computeKeepSet(
  project: Pick<Project, "id" | "activeDeploymentId"> & RollbackWindowProject,
  loaders?: KeepSetLoaders,
): Promise<Set<string>> {
  return new Set((await computeKeepSetDetail(project, loaders)).keys());
}

// ─── Per-image decision ──────────────────────────────────────────────────────

export interface ReapResult {
  removed: number;
  bytes: number;
  skippedInUse: number;
}

/**
 * Which of an image's refs WE may remove: its `openship/…` tags — we untag only
 * what we own, so Docker deletes the image when our last tag is gone, and
 * removing by tag (not image id) can never yank a foreign tag the operator
 * added — or the image id when it is truly dangling (NO tags at all: our
 * superseded, untagged final layer). An image left with only foreign tags was
 * re-purposed by the operator → nothing.
 */
function ownedRemovalRefs(img: { id: string; repoTags: string[] }): string[] {
  const ownTags = img.repoTags.filter((t) => t.startsWith("openship/"));
  if (ownTags.length > 0) return ownTags;
  if (img.repoTags.length === 0) return [img.id];
  return []; // only foreign tags → never touch
}

/**
 * Decide what to remove for ONE listed (label-scoped) image — the safety-
 * critical selection, kept pure + unit-tested so "never ruin an operator's
 * image" is verifiable:
 *   - in the keep-set (active/pinned/rollback-window) → keep (`[]`).
 *   - otherwise `ownedRemovalRefs` (own tags, or the id when dangling).
 */
export function selectImageRemovalRefs(
  img: { id: string; repoTags: string[] },
  keep: Set<string>,
): string[] {
  if (img.repoTags.some((t) => keep.has(t))) return [];
  return ownedRemovalRefs(img);
}

export type ImageKeepReason = KeepReason | "in-use" | "foreign-tag" | "min-age";
export type ImageRemoveReason = "superseded" | "dangling";

export type ImageDisposition =
  | { action: "keep"; reason: ImageKeepReason; refs: [] }
  | { action: "remove"; reason: ImageRemoveReason; refs: string[] };

/**
 * `selectImageRemovalRefs` with its reasoning attached — the one classifier
 * behind both the sweep and the read-only plan, so what the plan says would
 * happen is exactly what the sweep does:
 *   - a tag in the keep-set → keep, naming the strongest protection.
 *   - referenced by a container on the host (`usedImageIds`, when the caller
 *     listed them) → keep `in-use`. The sweep itself learns this from the
 *     daemon's 409; the plan looks first so it can SAY so.
 *   - nothing of ours to remove (foreign tags only) → keep `foreign-tag`.
 *   - younger than `minAgeMs`, or of unknown age when a minimum is set → keep
 *     `min-age`. Unknown counts as young: the age filter exists to make a sweep
 *     more conservative, never less.
 *   - else remove: `superseded` (our tags) or `dangling` (untagged leftover).
 */
export function classifyImage(
  img: { id: string; repoTags: string[]; createdAt?: number | null },
  keep: ReadonlyMap<string, KeepReason>,
  opts: { usedImageIds?: ReadonlySet<string>; minAgeMs?: number; now?: number } = {},
): ImageDisposition {
  let kept: KeepReason | undefined;
  for (const tag of img.repoTags) {
    const reason = keep.get(tag);
    if (
      reason !== undefined &&
      (kept === undefined || KEEP_PRIORITY[reason] < KEEP_PRIORITY[kept])
    ) {
      kept = reason;
    }
  }
  if (kept !== undefined) return { action: "keep", reason: kept, refs: [] };
  if (opts.usedImageIds?.has(img.id)) return { action: "keep", reason: "in-use", refs: [] };
  const refs = ownedRemovalRefs(img);
  if (refs.length === 0) return { action: "keep", reason: "foreign-tag", refs: [] };
  if (opts.minAgeMs !== undefined) {
    const now = opts.now ?? Date.now();
    if (
      img.createdAt === undefined ||
      img.createdAt === null ||
      now - img.createdAt < opts.minAgeMs
    ) {
      return { action: "keep", reason: "min-age", refs: [] };
    }
  }
  return { action: "remove", reason: img.repoTags.length === 0 ? "dangling" : "superseded", refs };
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

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
export async function reapProjectImages(
  project: Project,
  opts: ImageGcOptions = {},
): Promise<ReapResult> {
  const out: ReapResult = { removed: 0, bytes: 0, skippedInUse: 0 };
  if (!project.activeDeploymentId) return out; // no host to resolve
  const activeDep = await repos.deployment.findById(project.activeDeploymentId);
  if (!activeDep) return out;

  const { runtime } = await resolveDeploymentRuntime(activeDep);
  try {
    if (!(runtime instanceof DockerRuntime)) return out; // cloud/bare — nothing local
    const keep = await computeKeepSetDetail(project);
    const images = await runtime.listProjectImages(project.id);
    for (const img of images) {
      const verdict = classifyImage(img, keep, { minAgeMs: opts.minAgeMs });
      if (verdict.action === "keep") continue; // protected, or operator-repurposed → leave it
      try {
        for (const ref of verdict.refs) await runtime.removeImage(ref);
        out.removed += 1;
        out.bytes += img.size;
      } catch {
        // removeImage swallows not-found and re-throws everything else — an
        // in-use 409 (a container still references it) lands here. Treat as
        // "keep" and move on; never abort the sweep for one stuck image.
        out.skippedInUse += 1;
      }
    }
    // Reclaim this project's untagged (superseded final) layers too. Docker's
    // prune has no age filter, so an age-limited run leaves the backstop to the
    // next unfiltered sweep rather than removing something younger than asked.
    if (opts.minAgeMs === undefined) await runtime.pruneProjectDanglingImages(project.id);

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
export async function runImageGcSweep(opts: ImageGcOptions = {}): Promise<ImageGcSummary> {
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
      const r = await reapProjectImages(project, opts);
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

// ─── Plan (read-only) ────────────────────────────────────────────────────────

export interface ImagePlanEntry {
  id: string;
  repoTags: string[];
  buildId: string | null;
  deploymentId: string | null;
  size: number;
  /** Epoch ms, or null when the daemon didn't report it. */
  createdAt: number | null;
  action: "keep" | "remove";
  reason: ImageKeepReason | ImageRemoveReason;
  /** What a sweep would pass to `removeImage` — empty for a kept image. */
  refs: string[];
}

export type ProjectPlanSkipReason = "no-active-deployment" | "not-docker";

export interface ProjectImagePlan {
  projectId: string;
  slug: string;
  serverId: string | null;
  rollbackWindow: { window: number; source: RollbackWindowSource } | null;
  images: ImagePlanEntry[];
  reclaimableBytes: number;
  /** Why the host wasn't inspected (nothing deployed / not a Docker runtime). */
  skipped: ProjectPlanSkipReason | null;
  /** The host WAS supposed to be inspected and it failed (unreachable, daemon down). */
  error: string | null;
}

/**
 * What `reapProjectImages` WOULD do for one project, with reasons — and strictly
 * read-only: no prune, no capacity re-measure, nothing written. The extra
 * container listing is what lets the plan name an in-use image up front instead
 * of leaving it to the daemon's 409 at removal time.
 */
export async function planProjectImages(
  project: Project,
  opts: ImageGcOptions & { now?: number } = {},
): Promise<ProjectImagePlan> {
  const plan: ProjectImagePlan = {
    projectId: project.id,
    slug: project.slug,
    serverId: null,
    rollbackWindow: null,
    images: [],
    reclaimableBytes: 0,
    skipped: null,
    error: null,
  };
  if (!project.activeDeploymentId) return { ...plan, skipped: "no-active-deployment" };
  const activeDep = await repos.deployment.findById(project.activeDeploymentId);
  if (!activeDep) return { ...plan, skipped: "no-active-deployment" };
  plan.serverId = (activeDep.meta as { serverId?: string } | null)?.serverId ?? null;
  const window = await resolveRollbackWindowDetail(project);
  plan.rollbackWindow = { window: window.window, source: window.source };

  const { runtime } = await resolveDeploymentRuntime(activeDep);
  try {
    if (!(runtime instanceof DockerRuntime)) return { ...plan, skipped: "not-docker" };
    const keep = await computeKeepSetDetail(project);
    const [images, containers] = await Promise.all([
      runtime.listProjectImages(project.id),
      runtime.listAllContainers(),
    ]);
    const usedImageIds = new Set(containers.map((c) => c.imageId));
    for (const img of images) {
      const verdict = classifyImage(img, keep, {
        usedImageIds,
        minAgeMs: opts.minAgeMs,
        now: opts.now,
      });
      plan.images.push({
        id: img.id,
        repoTags: img.repoTags,
        buildId: img.buildId ?? null,
        deploymentId: img.deploymentId ?? null,
        size: img.size,
        createdAt: img.createdAt,
        action: verdict.action,
        reason: verdict.reason,
        refs: verdict.refs,
      });
      if (verdict.action === "remove") plan.reclaimableBytes += img.size;
    }
  } finally {
    await runtime.dispose?.();
  }
  return plan;
}

export interface ImageGcJobStatus {
  enabled: boolean;
  cron: string | null;
  lastRun: {
    id: string;
    status: string;
    trigger: string;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
    summary: Record<string, unknown> | null;
    error: string | null;
  } | null;
}

/** The `images:gc` schedule row + its most recent run, as the Jobs page has them. */
export async function getImageGcJobStatus(): Promise<ImageGcJobStatus | null> {
  const row = await repos.job.findByKey(IMAGE_GC_JOB_KEY);
  if (!row) return null;
  const [last] = await repos.jobRun.listRecent({ jobId: IMAGE_GC_JOB_KEY, limit: 1 });
  return {
    enabled: row.enabled,
    cron: row.cronExpression,
    lastRun: last
      ? {
          id: last.id,
          status: last.status,
          trigger: last.trigger,
          startedAt: last.startedAt,
          finishedAt: last.finishedAt,
          durationMs: last.durationMs,
          summary: (last.summary as Record<string, unknown> | null) ?? null,
          error: last.error,
        }
      : null,
  };
}

export interface ImageGcPlan {
  generatedAt: string;
  minAgeMs: number | null;
  job: ImageGcJobStatus | null;
  projects: ProjectImagePlan[];
  totals: {
    projects: number;
    /** Projects whose host was actually inspected. */
    scanned: number;
    images: number;
    candidates: number;
    reclaimableBytes: number;
    kept: Partial<Record<ImageKeepReason, number>>;
    errors: number;
  };
}

/**
 * The dry run: every project, the same way `runImageGcSweep` walks them, but
 * only ever reading. Per-project failures are reported on the project and
 * counted, never fatal — the point is to show the operator the whole picture.
 */
export async function planImageGc(opts: ImageGcOptions = {}): Promise<ImageGcPlan> {
  const now = Date.now();
  const projects = await repos.project.listAllForScan();
  const plans: ProjectImagePlan[] = [];
  const totals: ImageGcPlan["totals"] = {
    projects: projects.length,
    scanned: 0,
    images: 0,
    candidates: 0,
    reclaimableBytes: 0,
    kept: {},
    errors: 0,
  };
  for (const project of projects) {
    try {
      const plan = await planProjectImages(project, { minAgeMs: opts.minAgeMs, now });
      plans.push(plan);
      if (!plan.skipped) totals.scanned += 1;
      for (const img of plan.images) {
        totals.images += 1;
        if (img.action === "remove") {
          totals.candidates += 1;
          totals.reclaimableBytes += img.size;
        } else {
          const reason = img.reason as ImageKeepReason;
          totals.kept[reason] = (totals.kept[reason] ?? 0) + 1;
        }
      }
    } catch (err) {
      totals.errors += 1;
      plans.push({
        projectId: project.id,
        slug: project.slug,
        serverId: null,
        rollbackWindow: null,
        images: [],
        reclaimableBytes: 0,
        skipped: null,
        error: safeErrorMessage(err),
      });
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    minAgeMs: opts.minAgeMs ?? null,
    job: await getImageGcJobStatus(),
    projects: plans,
    totals,
  };
}
