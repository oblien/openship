/**
 * THE channel for "is anything out of date?" across every updatable entity — and
 * every entity is a project row (git projects, release/dist projects, the
 * self-app, webmail, installed template apps). The project page's banner, the
 * Apps tab, the home card and the issues feed all come through here, so they
 * cannot disagree about the same project.
 *
 * What is cached, and what is not:
 *
 *   `update_status` caches the UPSTREAM half of drift only — the branch HEAD, the
 *   newest release tag, the registry digest per service. That half costs a
 *   network round-trip per project and no local event announces when it moves, so
 *   it can only be polled.
 *
 *   The DEPLOYED half — what's actually running — is read live on every request.
 *   It's a local row lookup, and it is written by seven different code paths
 *   (deploy success, rollback, reconcile, activate, clear, self-deploy, migrate).
 *   Caching it meant every one of those needed an invalidation hook, and a missed
 *   hook left an operator staring at "update available" for a commit they had
 *   already shipped. Deriving it removes the hook requirement entirely.
 *
 * So `behind`, `latestInProgress` and both display labels are COMPUTED on read
 * (`evaluateDrift`), never stored.
 *
 * The cache is READ-THROUGH, and that is not an optimisation detail — it is what
 * makes the answer trustworthy. Enumerating cached ROWS meant a project nobody had
 * polled yet was indistinguishable from a project that was up to date, so the
 * issues feed said "nothing needs attention" while the same project's own page
 * showed a new commit. It now enumerates PROJECTS and treats a missing, expired or
 * no-longer-matching row as a question to answer, not as a "no". "Nothing needs
 * attention" is only ever printed after looking.
 *
 * Every poll — wherever it starts, including the project page's own banner — is
 * written back, so the surface an operator visits warms the surface they don't.
 * `updates:scan` is therefore a warm-up, not the only writer: the tracker is
 * correct on a cold cache, on desktop (where the job never runs at all), and on an
 * instance whose scheduler is broken.
 */

import { ValidationError } from "@repo/core";
import { repos, type NewUpdateStatus, type Project, type UpdateStatus } from "@repo/db";
import { buildBackgroundContext, type RequestContext } from "../../lib/request-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { mapWithLimit } from "../../lib/map-with-limit";
import {
  evaluateDrift,
  hasDeployedSide,
  resolveUpstreamDrift,
  upstreamMatchesSource,
  type DriftStatus,
  type UpstreamDrift,
} from "../projects/project-crud.service";
import { redeployBuildSession } from "../deployments/build.service";

// ─── Display labels ──────────────────────────────────────────────────────────

/** Tags that carry no version identity — fall back to the content digest for these. */
const FLOATING_TAGS = new Set(["latest", "stable", "main", "master", "edge", "nightly"]);

/** Tag portion of an image ref (`repo:tag` / `repo:tag@sha256:…`), or null if untagged. */
function imageTag(ref: string): string | null {
  const noDigest = ref.split("@")[0];
  const lastColon = noDigest.lastIndexOf(":");
  return lastColon > noDigest.lastIndexOf("/") ? noDigest.slice(lastColon + 1) : null;
}

/** Short form of a `sha256:…` (or bare hex) content digest. */
function shortDigest(digest?: string | null): string | null {
  if (!digest) return null;
  const hex = digest.includes(":") ? digest.slice(digest.indexOf(":") + 1) : digest;
  return hex.slice(0, 12) || null;
}

/**
 * Human-readable version for one image service: a pinned/specific tag reads as the
 * version; a floating tag (latest/stable/…) has none, so fall back to the short
 * content digest of the resolved image.
 */
function serviceVersion(ref: string, digest?: string | null): string | null {
  const tag = imageTag(ref);
  if (tag && !FLOATING_TAGS.has(tag)) return tag.length > 12 ? tag.slice(0, 12) : tag;
  return shortDigest(digest);
}

/** App-level version label across an image app's services (deduped; joined when they differ). */
function imageLabel(
  services: ReadonlyArray<{
    ref: string;
    deployedDigest?: string | null;
    latestDigest?: string | null;
  }>,
  side: "deployed" | "latest",
): string | null {
  const parts = [
    ...new Set(
      services
        .map((s) => serviceVersion(s.ref, side === "deployed" ? s.deployedDigest : s.latestDigest))
        .filter((v): v is string => !!v),
    ),
  ];
  return parts.length ? parts.join(", ") : null;
}

/**
 * The UI's "current → latest" strings, plus the mode-specific payload it renders.
 * Derived from the evaluated status so a label can never disagree with the
 * verdict shown beside it.
 */
function presentation(status: DriftStatus) {
  if (!status.supported) return null;
  if (status.mode === "commit") {
    return {
      currentLabel: status.deployedSha ? status.deployedSha.slice(0, 7) : null,
      latestLabel: status.latestSha ? status.latestSha.slice(0, 7) : null,
      detail: { branch: status.branch, latestMessage: status.latestMessage ?? null },
    };
  }
  if (status.mode === "release") {
    return {
      currentLabel: status.currentVersion ?? null,
      latestLabel: status.latestVersion ?? null,
      detail: { pinned: status.pinned },
    };
  }
  return {
    currentLabel: imageLabel(status.services, "deployed"),
    latestLabel: imageLabel(status.services, "latest"),
    detail: { services: status.services },
  };
}

// ─── Cache serialization ─────────────────────────────────────────────────────

/**
 * Upstream state → the cache row. Returns null for unsupported entities
 * (local/upload/no-remote projects) so they're skipped and any existing row is
 * dropped. The `key` fields ride along: they are what makes the row answerable
 * later, or knowably unanswerable.
 */
function toUpsert(project: Project, upstream: UpstreamDrift): Omit<NewUpdateStatus, "id"> | null {
  if (!upstream.supported) return null;
  const base = {
    organizationId: project.organizationId,
    projectId: project.id,
    checkedAt: new Date(),
  };
  if (upstream.mode === "commit") {
    return {
      ...base,
      kind: "commit",
      detail: {
        key: upstream.key,
        // Full sha, not the 7-char display prefix: this is compared against the
        // deployed sha on every read, and a truncated value can't be.
        latestSha: upstream.latestSha,
        latestMessage: upstream.latestMessage,
      },
    };
  }
  if (upstream.mode === "release") {
    return {
      ...base,
      kind: "release",
      detail: {
        key: upstream.key,
        latestVersion: upstream.latestVersion,
        pinned: upstream.pinned,
      },
    };
  }
  return { ...base, kind: "image", detail: { digestByRef: upstream.digestByRef } };
}

/**
 * The cache row → upstream state, for comparison against live deployed state.
 * Defensive about shapes: a row written by an older build (or hand-edited) reads
 * back as "upstream unknown", which reports no update rather than a wrong one.
 */
function fromCache(row: UpdateStatus): UpstreamDrift {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const key = typeof d.key === "string" ? d.key : "";
  if (row.kind === "commit") {
    return {
      supported: true,
      mode: "commit",
      key,
      latestSha: typeof d.latestSha === "string" ? d.latestSha : null,
      latestMessage: typeof d.latestMessage === "string" ? d.latestMessage : null,
    };
  }
  if (row.kind === "release") {
    return {
      supported: true,
      mode: "release",
      key,
      latestVersion: typeof d.latestVersion === "string" ? d.latestVersion : null,
      pinned: d.pinned === true,
    };
  }
  const digestByRef =
    d.digestByRef && typeof d.digestByRef === "object"
      ? (d.digestByRef as Record<string, string | null>)
      : {};
  return { supported: true, mode: "image", digestByRef };
}

// ─── Freshness policy ────────────────────────────────────────────────────────

/**
 * How long a RESOLVED upstream stays usable before a reader re-polls it. Matches
 * the `updates:scan` cron interval, so on a healthy instance the job refreshes
 * rows just before they expire and reads stay free; if the job never runs, the
 * read path simply does the work itself.
 */
const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Backoff for a poll that resolved NOTHING (rate limit, offline, private registry,
 * no credential). Recorded like any other poll so a broken source can't be retried
 * on every request — but for minutes, not the full TTL: a transient GitHub blip
 * must not blind the tracker for six hours.
 */
const UPSTREAM_RETRY_MS = 10 * 60 * 1000;

/** Concurrent upstream polls. One wave can be every project in an org. */
const POLL_LIMIT = 6;

/** Did the poll actually learn the upstream version, or come back empty-handed? */
function upstreamResolved(u: UpstreamDrift): boolean {
  if (!u.supported) return true; // definitive: this project has no upstream to poll
  if (u.mode === "commit") return u.latestSha !== null;
  if (u.mode === "release") return u.latestVersion !== null;
  const digests = Object.values(u.digestByRef);
  return digests.length > 0 && digests.some((d) => d !== null);
}

// ─── Polling (cache writes) ──────────────────────────────────────────────────

export interface ScanSummary {
  scanned: number;
  supported: number;
}

/**
 * Concurrent askers of the same project share one poll. The home card, the issues
 * page and a project page can all land in the same second, and on a cold cache
 * that is three identical GitHub calls — the kind of thing that earns a 403.
 */
const inFlight = new Map<string, Promise<UpstreamDrift>>();

/** Persist a polled upstream. An entity with no upstream drops its row. */
async function persistUpstream(project: Project, upstream: UpstreamDrift): Promise<void> {
  const row = toUpsert(project, upstream);
  if (!row) await repos.updateStatus.deleteByProject(project.id).catch(() => {});
  else await repos.updateStatus.upsert(row);
}

/**
 * Poll a project's upstream and cache the answer. The write-back is the point:
 * whoever pays for the round-trip pays it for every other surface too.
 *
 * A failed persist never fails the caller — the answer is already in hand, and
 * losing the cache entry only means the next reader polls again.
 */
async function pollUpstream(
  actor: RequestContext | null,
  project: Project,
): Promise<UpstreamDrift> {
  const shared = inFlight.get(project.id);
  if (shared) return shared;
  const run = (async () => {
    const upstream = await resolveUpstreamDrift(actor, project);
    await persistUpstream(project, upstream).catch(() => {});
    return upstream;
  })();
  inFlight.set(project.id, run);
  try {
    return await run;
  } finally {
    inFlight.delete(project.id);
  }
}

/**
 * The cached upstream if it still answers the question, otherwise a fresh poll.
 * Returns null when we deliberately didn't look: nothing is running, so nothing
 * can be behind, and a project in that state is worth no network at all.
 */
async function upstreamFor(
  actor: RequestContext | null,
  project: Project,
  row: UpdateStatus | undefined,
): Promise<{ upstream: UpstreamDrift; checkedAt: Date } | null> {
  if (!hasDeployedSide(project)) return null;

  if (row) {
    const cached = fromCache(row);
    const age = Date.now() - row.checkedAt.getTime();
    const window = upstreamResolved(cached) ? UPSTREAM_TTL_MS : UPSTREAM_RETRY_MS;
    if (age < window && (await upstreamMatchesSource(project, cached))) {
      return { upstream: cached, checkedAt: row.checkedAt };
    }
  }

  return { upstream: await pollUpstream(actor, project), checkedAt: new Date() };
}

/**
 * GitHub-backed upstream needs a credential, and background sweeps have no human
 * session — so resolve the org OWNER as the actor, exactly like the webhook
 * handlers do for auto-deploy. Before this, a ctx-less scan skipped the branch
 * HEAD lookup entirely, so the scheduled job could never detect a new commit:
 * git drift was only ever noticed when a logged-in user happened to open a page.
 *
 * Cached per org for the sweep's lifetime — one member lookup per org, not per
 * project. No owner → null, and the commit branch degrades to "upstream unknown"
 * (reported as not-behind rather than guessed).
 */
async function backgroundCtxFor(
  organizationId: string,
  cache: Map<string, RequestContext | null>,
): Promise<RequestContext | null> {
  const hit = cache.get(organizationId);
  if (hit !== undefined) return hit;
  const owner = await resolveOrgOwner(organizationId).catch(() => null);
  const ctx = owner
    ? buildBackgroundContext({ userId: owner.userId, organizationId, label: "updates:scan" })
    : null;
  cache.set(organizationId, ctx);
  return ctx;
}

/**
 * Refresh the cached upstream for a set of projects, so a reader finds a warm row
 * instead of paying for the poll. Best-effort per project — one failure never
 * aborts the sweep.
 */
async function scanProjects(ctx: RequestContext | null, rows: Project[]): Promise<ScanSummary> {
  let supported = 0;
  const ctxByOrg = new Map<string, RequestContext | null>();

  await mapWithLimit(rows, POLL_LIMIT, async (project) => {
    try {
      // Same gate the read path uses: an undeployed project can't be behind, so
      // sweeping it would spend a round-trip on an answer nobody compares.
      if (!hasDeployedSide(project)) return;
      const actor = ctx ?? (await backgroundCtxFor(project.organizationId, ctxByOrg));
      const upstream = await pollUpstream(actor, project);
      if (upstream.supported) supported += 1;
    } catch {
      /* best-effort: skip this project, keep scanning */
    }
  });

  return { scanned: rows.length, supported };
}

/** Scan every project in one org (the dashboard's explicit "check for updates"). */
export async function scanOrganizationUpdates(
  ctx: RequestContext | null,
  organizationId: string,
): Promise<ScanSummary> {
  // Large perPage → effectively "all projects" for a single org.
  const { rows } = await repos.project.listByOrganization(organizationId, { perPage: 1000 });
  return scanProjects(ctx, rows);
}

/**
 * Instance-wide sweep for the scheduled `updates:scan` job — every project across
 * all orgs, each org acting as its own owner (see `backgroundCtxFor`).
 */
export async function scanInstanceUpdates(): Promise<ScanSummary> {
  const rows = await repos.project.listAllForScan();
  return scanProjects(null, rows);
}

// No invalidation entry point, deliberately, and none is missing. Deployments
// can't stale this cache (the deployed side is read live); repointing a project
// can't either (the cached upstream stops matching the source, so the reader
// re-polls); and an absent row is a question, not a "no". There is no code path
// anywhere that has to remember to call us.

// ─── Reads ───────────────────────────────────────────────────────────────────

export type UpdateItem = NonNullable<Awaited<ReturnType<typeof driftItem>>>;

/**
 * One project's drift, as the dashboard renders it. Null when the project has no
 * drift question to answer (nothing deployed, no remote source, no image
 * services) — those are absent from every surface rather than listed as fine.
 */
async function driftItem(
  actor: RequestContext | null,
  project: Project,
  row: UpdateStatus | undefined,
) {
  const resolved = await upstreamFor(actor, project, row);
  if (!resolved) return null;
  const status: DriftStatus = await evaluateDrift(project, resolved.upstream).catch(
    () => ({ supported: false }) as DriftStatus,
  );
  const view = presentation(status);
  if (!view || !status.supported) return null;
  return {
    projectId: project.id,
    name: project.name,
    slug: project.slug ?? null,
    isApp: project.isApp ?? false,
    appTemplateId: project.appTemplateId ?? null,
    kind: status.mode,
    behind: status.behind,
    latestInProgress: status.latestInProgress,
    currentLabel: view.currentLabel,
    latestLabel: view.latestLabel,
    detail: view.detail,
    /** When the UPSTREAM side was last polled (the deployed side is live). */
    checkedAt: resolved.checkedAt,
  };
}

/**
 * Drift for every project in an org: cached upstream where it's still valid, a
 * fresh poll where it isn't, live deployed state always.
 *
 * Enumerates PROJECTS, not cache rows. That distinction is the whole fix — over
 * rows, a project the scanner had never reached looked exactly like a project with
 * nothing to report, which is how the issues feed came to say "nothing needs
 * attention" about a project whose own page was showing a new commit.
 */
export async function listOrganizationUpdates(
  ctx: RequestContext,
  opts?: { behindOnly?: boolean },
): Promise<UpdateItem[]> {
  const organizationId = ctx.organizationId;
  const [{ rows: projects }, cached] = await Promise.all([
    repos.project.listByOrganization(organizationId, { perPage: 1000 }),
    repos.updateStatus.listByOrg(organizationId).catch(() => []),
  ]);
  const rowByProject = new Map(cached.map((r) => [r.projectId, r]));

  const items: UpdateItem[] = [];
  await mapWithLimit(projects, POLL_LIMIT, async (project) => {
    // Per project: a source we can't reach must not cost us the other rows.
    const item = await driftItem(ctx, project, rowByProject.get(project.id)).catch(() => null);
    if (item) items.push(item);
  });

  // Deterministic despite the concurrency: behind first, then by name.
  items.sort((a, b) => Number(b.behind) - Number(a.behind) || a.name.localeCompare(b.name));
  return opts?.behindOnly ? items.filter((i) => i.behind) : items;
}

/**
 * Fresh drift for ONE project — the project page's "your deploy is behind"
 * banner, where the operator is about to press the button and the answer has to
 * be current rather than merely recent. Always polls, and the write-back means
 * the visit also settles what the feed and the home card will say.
 */
export async function getProjectDrift(
  ctx: RequestContext,
  projectId: string,
): Promise<DriftStatus> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!hasDeployedSide(project)) return { supported: false };
  return evaluateDrift(project, await pollUpstream(ctx, project));
}

// ─── Applying ────────────────────────────────────────────────────────────────

/**
 * Apply the available update to a project (app / git / release / self-app). Runs
 * a redeploy with the `update` trigger — which force-pulls image tags and
 * recreates every image service, and (for release/git projects) rolls forward
 * to the latest version/commit — after firing a pre-deploy backup. The existing
 * rollback-orchestrator auto-archive gives one-click revert. Returns the new
 * deployment id so the UI can follow build progress.
 *
 * Deliberately does not touch `update_status`: the upstream hasn't moved, and the
 * nudge stops the moment the deployment row exists, because `latestInProgress` is
 * computed live. (The previous rescan here re-armed the banner it had just
 * cleared — `redeployBuildSession` returns while the build is still queued, so a
 * rescan at this instant recomputed drift against the version being replaced.)
 */
export async function applyProjectUpdate(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) {
    throw new ValidationError("Deploy this project before updating it.");
  }
  return redeployBuildSession(ctx, project.activeDeploymentId, {
    trigger: "update",
    preDeployBackup: true,
  });
}
