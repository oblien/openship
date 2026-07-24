/**
 * Atomic project teardown.
 *
 * Single source of truth for "delete this project, everywhere, or fail
 * loud". Replaces the legacy soft-delete-after-best-effort-cleanup flow
 * in project-cleanup.service. Two-phase:
 *
 *   1. Gate. `getActiveProjectState` lists deployments / build sessions /
 *      backup runs / restores still in flight. The route refuses (409)
 *      unless `force=true`, in which case we cancel each and wait briefly
 *      for confirmed quiescence.
 *   2. Sequence. Every named step runs inside its own try/catch and
 *      reports {step, status, details?, error?} so the caller can render
 *      partial-success states. The DB row only hard-deletes after the
 *      remote/runtime steps run — but the row drop itself is its own step
 *      too, so a successful row drop with one stuck external resource
 *      still returns 207 with that step marked `failed` in the response.
 *
 * The teardown sequence is INTENTIONALLY ordered:
 *   webhook → runtime resources → webmail → DB row.
 * GitHub first because once the row is gone we lose `webhookId`. Runtime
 * resources next because the existing manifest reads container/volume
 * metadata from `deployment`+`service` rows that the FK CASCADE will
 * later drop. Webmail (filesystem branding + mail-state block) runs
 * before the DB drop so a partial failure still leaves the project
 * resolvable in the dashboard. The DB hard-delete is last, and FK
 * ON DELETE CASCADE on `project.id` (deployment, service, env_var,
 * domain, backup_policy) does the dependent-row sweep in one statement.
 */

import { repos, type Project, type BackupRun, type BackupRestore } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import {
  collectProjectManifest,
  executeCleanup,
} from "./project-cleanup.service";
import { removeProjectFromServerManifests } from "../../lib/openship-manifest-sync";
import { cancelBuildSession } from "../deployments/build.service";
import { deleteWebhook as deleteGitHubWebhook } from "../github/github.service";
import type { RequestContext } from "../../lib/request-context";
import { env } from "../../config";
import {
  cleanupWebmailInstall,
  mailServerIdFromWebmailSlug,
} from "../mail/webmail/webmail-project.service";

// ─── Public types ─────────────────────────────────────────────────────────────

export type TeardownStepStatus = "ok" | "failed" | "skipped";

export interface TeardownStep {
  step: string;
  status: TeardownStepStatus;
  details?: string;
  error?: string;
}

/**
 * When teardown bails before the step sequence runs, `rejection` carries
 * the typed reason so the controller can map it to the right HTTP code +
 * audit event. Undefined on the normal path.
 *
 *   - "claim_lock_held"   another teardown is already running → 409
 *   - "already_deleted"   row missing / soft-deleted → 200 (idempotent)
 *   - "org_mismatch"      project belongs to a different org → 403/404
 *                         (controller decides — currently 404 to stay
 *                         IDOR-safe)
 */
export type TeardownRejectionKind =
  | "claim_lock_held"
  | "already_deleted"
  | "org_mismatch"
  | "control_plane";

/** A remote resource we couldn't destroy now (server unreachable, or a
 *  force-orphaned failure) and recorded for the GC sweep to reclaim later. */
export interface OrphanedResourceSummary {
  ref: string;
  label: string;
  serverId: string | null;
}

export interface TeardownResult {
  /** True only when EVERY step is `ok` or `skipped`. */
  ok: boolean;
  /** True iff the project DB row was hard-deleted. A partial teardown can
   *  have rowDeleted=true with non-empty unrecoverable (orphans flagged
   *  for ops) or rowDeleted=false with the DB row still resolvable. */
  rowDeleted: boolean;
  steps: TeardownStep[];
  /** Steps that failed and the user should know about. Empty array on
   *  full success — drives the dashboard's "partial-success" warning. */
  unrecoverable: TeardownStep[];
  /** Remote resources orphaned for later GC (server was unreachable, or
   *  force-orphaned). The row still dropped — this is an INTENTIONAL outcome,
   *  not a failure. Drives the "will be cleaned up when the server is back"
   *  message. */
  orphaned: OrphanedResourceSummary[];
  /** Set when teardown short-circuited before the step sequence; absent
   *  on the normal "ran to completion" path. */
  rejection?: TeardownRejectionKind;
}

export interface PreflightActiveState {
  // In-flight deployment IS the in-flight build: build_session.deployment_id
  // is FK to deployment, so they share lifecycle. One flag is enough.
  hasActiveDeployment: boolean;
  hasActiveBackup: boolean;
  hasActiveBackupRestore: boolean;
  /** IDs the caller needs to either cancel (force=true) or wait on. */
  activeDeploymentIds: string[];
  activeBackupRunIds: string[];
  activeBackupRestoreIds: string[];
  /** Human-readable one-liner for the 409 body. */
  summary: string;
  /** True when any of the above is true. */
  blocking: boolean;
}

export interface TeardownOptions {
  force: boolean;
  /** wipeVolumes is plumbed through to the runtime manifest. */
  wipeVolumes?: boolean;
  /**
   * Keep the GitHub webhook instead of unregistering it. Used by
   * promote-to-cloud: the project's data has been copied to the SaaS, which
   * keeps using the SAME webhook to auto-deploy — so we tear down the local
   * runtime + rows but must NOT delete the webhook.
   */
  preserveWebhook?: boolean;
  /**
   * Record-only ("soft") delete: drop just the Openship DB record and LEAVE the
   * server workload + data + on-server manifest intact, so the project can be
   * re-imported later. Self-hosted only — IGNORED for a cloud project (its
   * resources live on Oblien and must be reclaimed). Enforced in teardownProject.
   */
  recordOnly?: boolean;
  /**
   * Orphan-and-drop even when a resource on a REACHABLE server fails to
   * destroy (a persistent real error). Records the leaked resources for GC and
   * lets the row drop instead of blocking forever. Unreachable-server resources
   * are ALWAYS orphaned (enforced delete) regardless of this flag.
   */
  forceOrphan?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_DEPLOYMENT_STATUSES = ["queued", "building", "deploying"] as const;

/** Max wait for cancellations to land before we give up and barrel on. */
const QUIESCE_TIMEOUT_MS = 5000;
const QUIESCE_POLL_MS = 250;

// ─── Preflight ────────────────────────────────────────────────────────────────

export async function getActiveProjectState(projectId: string): Promise<PreflightActiveState> {
  const { rows: deps } = await repos.deployment.listByProject(projectId, {
    page: 1,
    perPage: 50,
  });
  const activeDeployments = deps.filter((d) =>
    (ACTIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(d.status),
  );

  const [runs, restores] = await Promise.all([
    repos.backupRun.listInFlightByProject(projectId).catch((): BackupRun[] => []),
    repos.backupRestore.listInFlightByProject(projectId).catch((): BackupRestore[] => []),
  ]);

  const parts: string[] = [];
  if (activeDeployments.length > 0) {
    parts.push(`${activeDeployments.length} active deployment(s)`);
  }
  if (runs.length > 0) parts.push(`${runs.length} backup run(s)`);
  if (restores.length > 0) parts.push(`${restores.length} backup restore(s)`);

  return {
    hasActiveDeployment: activeDeployments.length > 0,
    hasActiveBackup: runs.length > 0,
    hasActiveBackupRestore: restores.length > 0,
    activeDeploymentIds: activeDeployments.map((d) => d.id),
    activeBackupRunIds: runs.map((r) => r.id),
    activeBackupRestoreIds: restores.map((r) => r.id),
    blocking: parts.length > 0,
    summary:
      parts.length === 0
        ? "No active work"
        : `Cannot delete while in-flight: ${parts.join(", ")}`,
  };
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

export async function teardownProject(
  ctx: RequestContext,
  projectId: string,
  opts: TeardownOptions,
): Promise<TeardownResult> {
  const steps: TeardownStep[] = [];
  const push = (s: TeardownStep) => {
    steps.push(s);
    return s;
  };

  // The Openship control plane is the host service, not a torn-down workload —
  // refuse BEFORE claiming the lock so we never mangle its row. (The controller
  // guards this too; this is defense-in-depth for any other caller.)
  const preload = await repos.project.findById(projectId).catch(() => undefined);
  if (preload?.appTemplateId === "openship") {
    push({
      step: "guard_control_plane",
      status: "failed",
      error: "The Openship control plane can't be torn down via the API — manage it with the CLI.",
    });
    return finalize(steps, false, "control_plane");
  }

  // Claim the deletion lock. Two concurrent DELETEs lose the same row
  // race otherwise — a failed claim has three distinct causes:
  //   (a) Another teardown is in flight  → "claim_lock_held"  (409)
  //   (b) The row is already gone        → "already_deleted"  (200, idempotent)
  //   (c) Real DB error
  // We re-read the row to tell them apart so the controller emits the
  // right code + audit event.
  const claimed = await repos.project.claimDeletion(projectId);
  if (!claimed) {
    let existing: Project | undefined;
    try {
      existing = await repos.project.findById(projectId);
    } catch (err) {
      push({ step: "claim_lock", status: "failed", error: safeErrorMessage(err) });
      return finalize(steps, false);
    }

    if (!existing || existing.deletedAt) {
      push({
        step: "claim_lock",
        status: "skipped",
        details: "project already deleted",
      });
      return finalize(steps, false, "already_deleted");
    }

    if (existing.deletionInProgress) {
      push({
        step: "claim_lock",
        status: "failed",
        error: "Another teardown is already in progress for this project",
      });
      return finalize(steps, false, "claim_lock_held");
    }

    // Lost the race for some other reason — surface as a generic failure.
    push({
      step: "claim_lock",
      status: "failed",
      error: "Failed to claim deletion lock",
    });
    return finalize(steps, false);
  }

  // Everything past the claim runs UNDER the lock. Release it in `finally`
  // on ANY exit — throw, early return, or normal completion — UNLESS the row
  // was deleted (then there's no row to unlock). This is what stops a thrown
  // step from leaving the project permanently stuck at "Another delete is
  // already running". (A true infinite hang is bounded by the step timeouts;
  // a process death mid-teardown is recovered by clearStaleDeletions at boot.)
  let rowDeleted = false;
  try {
    let project: Project | undefined;
    try {
      project = await repos.project.findById(projectId);
    } catch (err) {
      push({ step: "load_project", status: "failed", error: safeErrorMessage(err) });
    }

    if (!project) {
      push({
        step: "load_project",
        status: "failed",
        error: "Project not found",
      });
      return finalize(steps, false, "already_deleted");
    }

    // Belt-and-suspenders org check. The route's `assertResourceInOrg`
    // should already have refused before we got here, but if a future
    // caller forgets we MUST NOT destroy a project belonging to another
    // org. Mismatch returns a typed rejection so the controller can
    // surface PROJECT_ORG_MISMATCH; we treat it like a load failure.
    if (project.organizationId !== ctx.organizationId) {
      push({
        step: "load_project",
        status: "failed",
        error: "PROJECT_ORG_MISMATCH",
      });
      return finalize(steps, false, "org_mismatch");
    }

    // Record-only ("soft") delete: keep the server workload + data, drop just
    // the Openship record. NEVER honored for a cloud project — its resources
    // live on Oblien and must be reclaimed; this is the security boundary, not
    // the UI toggle. (CLOUD_MODE = the SaaS itself, where nothing is "kept".)
    const recordOnly = !!opts.recordOnly && !project.cloudWorkspaceId && !env.CLOUD_MODE;

    // ── Step 1: Cancel in-flight work (force=true only). ────────────────
    if (opts.force) {
      await stepCancelInFlight(projectId, ctx.userId, push);
    } else {
      push({ step: "cancel_in_flight", status: "skipped", details: "force=false" });
    }

    // ── Step 2: Unregister GitHub webhook (unless preserving it). ────────
    // promote-to-cloud keeps the webhook: the cloud copy auto-deploys via the
    // same hook, so deleting it here would break the now-cloud project.
    if (opts.preserveWebhook) {
      push({ step: "github_webhook", status: "skipped", details: "preserved (promote to cloud)" });
    } else {
      await stepDeleteWebhook(ctx, project, push);
    }

    // ── Steps 3+4: server-resource teardown — SKIPPED for record-only. ──
    // Record-only keeps the workload, data, AND the on-server .openship manifest
    // (so a later Docker re-scan can re-import the project); it drops only the DB
    // row below. Otherwise: tear down runtime + edge + pages + routes + volumes
    // (cloud workspaces destroy through the same path — the cloud adapter
    // implements destroy()), webmail, and the server manifest entry.
    let orphaned: OrphanedResourceSummary[] = [];
    if (recordOnly) {
      push({ step: "runtime_cleanup", status: "skipped", details: "record-only: kept on server" });
      push({ step: "webmail", status: "skipped", details: "record-only: kept on server" });
    } else {
      // Resources on an unreachable server are orphaned (not destroyed inline)
      // and returned here so we can record them for GC before the row drops.
      const orphanCandidates = await stepRuntimeCleanup(
        project,
        opts.wipeVolumes ?? false,
        opts.forceOrphan ?? false,
        push,
      );

      await stepWebmailTeardown(project, push);

      // Best-effort: drop this project from each server's .openship manifest so a
      // later recover-from-server scan doesn't re-list it. Desktop-only inside;
      // never gates the delete (reconcile's running-container check is the guard).
      await removeProjectFromServerManifests(project).catch(() => {});

      // ── ATOMICITY GATE: never drop the DB row while the SOURCE is dirty. ──
      // If runtime cleanup (containers / images / volumes / cloud workspace /
      // routes) or webmail teardown FAILED, KEEP the project row so the leaked
      // resources still have a record to retry against. The `finally` below
      // releases the lock (rowDeleted stays false), so the next delete attempt
      // re-runs cleanup. The returned result carries the failed steps
      // (finalize → ok:false, unrecoverable) so the UI shows what blocked it.
      // GitHub-webhook unregister is best-effort (external state, not a host
      // resource leak) and deliberately does NOT gate the delete.
      const sourceClean = steps.every(
        (s) =>
          (s.step !== "runtime_cleanup" && s.step !== "webmail") ||
          s.status === "ok" ||
          s.status === "skipped",
      );
      if (!sourceClean) {
        push({
          step: "delete_db_row",
          status: "skipped",
          details: "kept: source cleanup incomplete — retry once the runtime is reachable",
        });
        return finalize(steps, false);
      }

      // About to drop the row — persist any orphaned resources FIRST so the GC
      // sweep can still find + reclaim them after the project row (their only
      // record) is gone. Only happens on the row-dropping path: a kept row keeps
      // the resources tracked via the project itself, so no orphan record needed.
      orphaned = await persistOrphans(ctx.organizationId, projectId, orphanCandidates);
    }

    // ── Step 5: Drop the DB row. FK CASCADE on project.id sweeps
    //   deployment, service, env_var, domain, backup_policy.
    rowDeleted = await stepDeleteRow(projectId, project.groupId, push);

    return finalize(steps, rowDeleted, undefined, orphaned);
  } finally {
    // Lock released on every non-deleting exit so a retry is always possible.
    if (!rowDeleted) {
      await repos.project.clearDeletionInProgress(projectId).catch(() => {});
    }
  }
}

function finalize(
  steps: TeardownStep[],
  rowDeleted: boolean,
  rejection?: TeardownRejectionKind,
  orphaned: OrphanedResourceSummary[] = [],
): TeardownResult {
  const unrecoverable = steps.filter((s) => s.status === "failed");
  return {
    ok: unrecoverable.length === 0,
    rowDeleted,
    steps,
    unrecoverable,
    orphaned,
    ...(rejection !== undefined ? { rejection } : {}),
  };
}

// ─── Step implementations ─────────────────────────────────────────────────────

async function stepCancelInFlight(
  projectId: string,
  actorUserId: string,
  push: (s: TeardownStep) => void,
): Promise<void> {
  const before = await getActiveProjectState(projectId);
  if (!before.blocking) {
    push({ step: "cancel_in_flight", status: "skipped", details: "nothing in flight" });
    return;
  }

  const cancelErrors: string[] = [];

  // Cancel each active deployment — cancelBuildSession aborts the build,
  // tears down half-provisioned containers/images, and marks the row
  // cancelled. Best-effort: a deployment that has already finished
  // between listing and cancelling will throw ForbiddenError, which we
  // ignore — the next quiesce poll will pick that up.
  for (const depId of before.activeDeploymentIds) {
    try {
      await cancelBuildSession(depId);
    } catch (err) {
      cancelErrors.push(`deployment ${depId}: ${safeErrorMessage(err)}`);
    }
  }

  // Mark in-flight backup runs cancelled via the FSM. We do not have a
  // worker-side abort signal yet, so the runner will notice the state
  // change on its next FSM transition and bail out of writes.
  for (const runId of before.activeBackupRunIds) {
    try {
      await repos.backupRun.transition(runId, "cancelled", {
        errorMessage: "Cancelled by project deletion (force=true)",
      });
    } catch (err) {
      cancelErrors.push(`backup_run ${runId}: ${safeErrorMessage(err)}`);
    }
  }

  for (const restoreId of before.activeBackupRestoreIds) {
    try {
      await repos.backupRestore.transition(restoreId, "cancelled", {
        errorMessage: "Cancelled by project deletion (force=true)",
      });
    } catch (err) {
      cancelErrors.push(`backup_restore ${restoreId}: ${safeErrorMessage(err)}`);
    }
  }

  // Brief poll for quiescence — gives the runner a window to notice the
  // status flip before runtime cleanup tries to destroy a container the
  // runner is still touching. We give up at QUIESCE_TIMEOUT_MS and let
  // the manifest executor's per-resource retry deal with stragglers.
  const deadline = Date.now() + QUIESCE_TIMEOUT_MS;
  let last = before;
  while (Date.now() < deadline) {
    last = await getActiveProjectState(projectId);
    if (!last.blocking) break;
    await new Promise((r) => setTimeout(r, QUIESCE_POLL_MS));
  }

  if (last.blocking) {
    push({
      step: "cancel_in_flight",
      status: "failed",
      details: last.summary,
      error: `Timed out waiting for quiescence after ${QUIESCE_TIMEOUT_MS}ms`,
    });
    return;
  }

  push({
    step: "cancel_in_flight",
    status: cancelErrors.length === 0 ? "ok" : "failed",
    details: `cancelled ${before.activeDeploymentIds.length} deployment(s), ${before.activeBackupRunIds.length} backup run(s), ${before.activeBackupRestoreIds.length} restore(s)`,
    error: cancelErrors.length === 0 ? undefined : cancelErrors.join("; "),
  });
}

async function stepDeleteWebhook(
  ctx: RequestContext,
  project: Project,
  push: (s: TeardownStep) => void,
): Promise<void> {
  if (!project.webhookId || !project.gitOwner || !project.gitRepo) {
    push({ step: "github_webhook", status: "skipped", details: "no webhook bound" });
    return;
  }
  try {
    await deleteGitHubWebhook(
      ctx,
      project.gitOwner,
      project.gitRepo,
      project.webhookId,
    );
    push({ step: "github_webhook", status: "ok", details: `hook ${project.webhookId}` });
  } catch (err) {
    // GitHub returns 404 when the hook is already gone — treat as a
    // skip, not a failure. Anything else (auth, network) bubbles up.
    const msg = safeErrorMessage(err);
    if (msg.toLowerCase().includes("not found") || msg.includes("404")) {
      push({ step: "github_webhook", status: "skipped", details: "already gone" });
      return;
    }
    push({ step: "github_webhook", status: "failed", error: msg });
  }
}

/** A remote resource to record for GC (server unreachable, or force-orphaned). */
interface OrphanCandidate {
  serverId: string | null;
  resourceType: string;
  ref: string;
  label: string;
  runtimeMode: string | null;
}

async function stepRuntimeCleanup(
  project: Project,
  wipeVolumes: boolean,
  forceOrphan: boolean,
  push: (s: TeardownStep) => void,
): Promise<OrphanCandidate[]> {
  const orphans: OrphanCandidate[] = [];
  let manifest;
  try {
    manifest = await collectProjectManifest(project, { wipeVolumes });
  } catch (err) {
    push({
      step: "runtime_cleanup",
      status: "failed",
      error: `Manifest collection failed: ${safeErrorMessage(err)}`,
    });
    return orphans;
  }

  if (manifest.resources.length === 0) {
    push({ step: "runtime_cleanup", status: "skipped", details: "no resources" });
    return orphans;
  }

  // ENFORCED DELETE: resources on an UNREACHABLE server are never destroyed
  // inline (that inline destroy is the ~81s hang). Orphan them for the GC sweep
  // to reclaim once the server is back, and let the delete proceed. Everything
  // else goes through the normal destroy path.
  const unreachable = manifest.resources.filter((r) => r.type === "unreachable");
  const destroyable = manifest.resources.filter((r) => r.type !== "unreachable");

  for (const r of unreachable) {
    orphans.push({
      serverId: r.serverId ?? null,
      resourceType: "container",
      ref: r.ref,
      label: r.label,
      runtimeMode: r.runtimeMode ?? null,
    });
  }

  const orphanNote = unreachable.length
    ? `; ${unreachable.length} orphaned (server unreachable)`
    : "";

  if (destroyable.length === 0) {
    // Nothing reachable to destroy — only unreachable orphans. The delete
    // proceeds (row drops); GC reclaims the orphans later.
    push({
      step: "runtime_cleanup",
      status: unreachable.length ? "ok" : "skipped",
      details: unreachable.length ? orphanNote.slice(2) : "no resources",
    });
    return orphans;
  }

  // Force-orphan short-circuit: the operator chose "delete from storage anyway",
  // so DON'T attempt the inline SSH destroy at all (that's the call that can hang
  // ~80s on a slow/failing runtime and is why the escape felt stuck). Record
  // every reachable resource as an orphan for the GC sweep and let the row drop
  // now. Reachable manifest items don't carry their own serverId/runtimeMode, so
  // stamp them with the project's primary target (same as the post-failure path).
  if (forceOrphan) {
    const target = await resolvePrimaryTarget(project.id);
    for (const r of destroyable) {
      orphans.push({
        serverId: r.serverId ?? target.serverId,
        resourceType: r.type === "unreachable" ? "container" : r.type,
        ref: r.ref,
        label: r.label,
        runtimeMode: r.runtimeMode ?? target.runtimeMode,
      });
    }
    push({
      step: "runtime_cleanup",
      status: "ok",
      details: `${destroyable.length} force-orphaned (storage-only delete)${orphanNote}`,
    });
    return orphans;
  }

  const result = await executeCleanup({ projectId: manifest.projectId, resources: destroyable });
  const realFailures = result.failed;
  const details =
    `${result.succeeded}/${result.total} ok` + (wipeVolumes ? " (volumes wiped)" : "") + orphanNote;

  if (realFailures.length === 0) {
    push({ step: "runtime_cleanup", status: "ok", details });
    return orphans;
  }

  // Reachable server, but destroy kept failing WITHOUT forceOrphan (the
  // forceOrphan case short-circuited above, before executeCleanup). Mark failed
  // so the atomicity gate keeps the row and surfaces canForceOrphan — a later
  // retry with forceOrphan drops it via the fast path.
  push({
    step: "runtime_cleanup",
    status: "failed",
    details,
    error: realFailures.map((f) => `${f.label}: ${f.error}`).join("; "),
  });
  return orphans;
}

/** Best-effort project target (serverId/runtimeMode) from its latest deployment
 *  snapshot — used to stamp force-orphaned resources so GC can resolve a runtime. */
async function resolvePrimaryTarget(
  projectId: string,
): Promise<{ serverId: string | null; runtimeMode: string | null }> {
  const res = await repos.deployment
    .listByProject(projectId, { perPage: 1 })
    .catch(() => ({ rows: [] as Array<{ meta?: unknown }> }));
  const meta = (res.rows[0]?.meta ?? {}) as { serverId?: string; runtimeMode?: string };
  return { serverId: meta.serverId ?? null, runtimeMode: meta.runtimeMode ?? null };
}

/** Persist orphan candidates so the GC sweep can reclaim them after the project
 *  row is gone. Best-effort per row — a failed insert is logged, not fatal. */
async function persistOrphans(
  organizationId: string,
  projectId: string,
  candidates: OrphanCandidate[],
): Promise<OrphanedResourceSummary[]> {
  const out: OrphanedResourceSummary[] = [];
  for (const c of candidates) {
    try {
      await repos.orphanedResource.create({
        organizationId,
        serverId: c.serverId,
        resourceType: c.resourceType,
        ref: c.ref,
        projectId,
        label: c.label,
        runtimeMode: c.runtimeMode,
      });
      out.push({ ref: c.ref, label: c.label, serverId: c.serverId });
    } catch (err) {
      console.error(`[teardown] failed to record orphan ${c.ref}:`, safeErrorMessage(err));
    }
  }
  return out;
}

async function stepWebmailTeardown(
  project: Project,
  push: (s: TeardownStep) => void,
): Promise<void> {
  if (project.framework !== "webmail") {
    push({ step: "webmail", status: "skipped", details: "not a webmail project" });
    return;
  }
  const mailServerId = mailServerIdFromWebmailSlug(project.slug);
  if (!mailServerId) {
    push({ step: "webmail", status: "skipped", details: "no mail server id" });
    return;
  }
  try {
    await cleanupWebmailInstall({ mailServerId });
    push({ step: "webmail", status: "ok", details: mailServerId });
  } catch (err) {
    push({ step: "webmail", status: "failed", error: safeErrorMessage(err) });
  }
}

async function stepDeleteRow(
  projectId: string,
  groupId: string,
  push: (s: TeardownStep) => void,
): Promise<boolean> {
  try {
    // `domain.projectId` has ON DELETE CASCADE (schema/domain.ts:23), so
    // `deleteHard` sweeps domain rows for free. No explicit pre-delete.
    await repos.project.deleteHard(projectId);

    // If the only environment for this app is gone, soft-delete the
    // app row too. We don't hard-delete the app — sibling environments
    // for other orgs (theoretical) would CASCADE-drop, but the app row
    // is org-scoped so leaving it soft-deleted keeps audit history
    // intact for the org.
    const remaining = await repos.project.listByGroup(groupId).catch(() => []);
    if (remaining.length === 0) {
      await repos.projectGroup.softDelete(groupId).catch(() => {});
    }

    push({ step: "delete_db_row", status: "ok" });
    return true;
  } catch (err) {
    push({ step: "delete_db_row", status: "failed", error: safeErrorMessage(err) });
    return false;
  }
}
