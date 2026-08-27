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
 *   webhook → runtime resources → webmail → unlink consumers → DB row.
 * Unlinking the projects that CONSUME this app is the last thing before the row
 * drops: a runtime cleanup that fails (unreachable server → row kept) must not
 * strip another project's env var while the app it points at is still alive.
 * GitHub first because once the row is gone we lose `webhookId`. Runtime
 * resources next because the existing manifest reads container/volume
 * metadata from `deployment`+`service` rows that the FK CASCADE will
 * later drop. Webmail (filesystem branding + mail-state block) runs
 * before the DB drop so a partial failure still leaves the project
 * resolvable in the dashboard. The DB hard-delete is last, and FK
 * ON DELETE CASCADE on `project.id` (deployment, service, env_var,
 * domain, backup_policy) does the dependent-row sweep in one statement.
 */

import { repos, type Project } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import {
  collectProjectManifest,
  disposeManifestRuntimes,
  executeCleanup,
} from "./project-cleanup.service";
import { removeProjectFromServerManifests } from "../../lib/openship-manifest-sync";
import { cancelBuildSession } from "../deployments/build.service";
import { restoreOrchestrator } from "../backups/restore.orchestrator";
import { deleteWebhook as deleteGitHubWebhook } from "../github/github.service";
import type { RequestContext } from "../../lib/request-context";
import { env } from "../../config";
import { cleanupWebmailInstall } from "../mail/webmail/webmail-install.service";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";

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
  | "active_work"
  | "control_plane";

/** A remote resource we couldn't destroy now (server unreachable, or a
 *  force-orphaned failure) and recorded for the GC sweep to reclaim later. */
export interface OrphanedResourceSummary {
  ref: string;
  label: string;
  serverId: string | null;
}

/** A project we unlinked from this app on the way out: it keeps running, minus
 *  `envKey`. Its live container still holds the (now dead) value until its next
 *  deploy — which is what the caller reports back to the user. */
export interface UnlinkedConsumerSummary {
  linkId: string;
  projectId: string;
  projectName: string;
  envKey: string;
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
  /** Projects unlinked from this app as part of the delete. Empty for a project
   *  nothing was wired into. */
  unlinked: UnlinkedConsumerSummary[];
  /** True only when the row was kept solely because destruction of reachable
   * runtime resources failed. Retrying with `forceOrphan` can safely replace
   * that destroy attempt with durable deferred-cleanup records. */
  canForceOrphan: boolean;
  /** Present with `rejection: "active_work"`; captured while the deletion
   * lock was held, so it is the authoritative gate rather than a UI precheck. */
  active?: PreflightActiveState;
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
  hasActiveMigration: boolean;
  /** IDs the caller needs to either cancel (force=true) or wait on. */
  activeDeploymentIds: string[];
  activeBackupRunIds: string[];
  activeBackupRestoreIds: string[];
  activeMigrationIds: string[];
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

/** Max wait for cancellations to land before teardown refuses to touch resources. */
const QUIESCE_TIMEOUT_MS = 5000;
const QUIESCE_POLL_MS = 250;

// ─── Preflight ────────────────────────────────────────────────────────────────

export async function getActiveProjectState(projectId: string): Promise<PreflightActiveState> {
  // Every query is exact and fail-closed. An unreadable work table is NOT proof
  // of quiescence; letting an error propagate retains the row via `finally`.
  const [activeDeployments, runs, restores, migration] = await Promise.all([
    repos.deployment.listInFlightByProject(projectId),
    repos.backupRun.listInFlightByProject(projectId),
    repos.backupRestore.listInFlightByProject(projectId),
    repos.dockerMigrationRun.findActiveForProject(projectId),
  ]);

  const parts: string[] = [];
  if (activeDeployments.length > 0) {
    parts.push(`${activeDeployments.length} active deployment(s)`);
  }
  if (runs.length > 0) parts.push(`${runs.length} backup run(s)`);
  if (restores.length > 0) parts.push(`${restores.length} backup restore(s)`);
  if (migration) parts.push("1 Docker migration");

  return {
    hasActiveDeployment: activeDeployments.length > 0,
    hasActiveBackup: runs.length > 0,
    hasActiveBackupRestore: restores.length > 0,
    hasActiveMigration: Boolean(migration),
    activeDeploymentIds: activeDeployments.map((d) => d.id),
    activeBackupRunIds: runs.map((r) => r.id),
    activeBackupRestoreIds: restores.map((r) => r.id),
    activeMigrationIds: migration ? [migration.id] : [],
    blocking: parts.length > 0,
    summary:
      parts.length === 0 ? "No active work" : `Cannot delete while in-flight: ${parts.join(", ")}`,
  };
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function teardownProjectLocked(
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

  // Publish the deletion fence after acquiring the cross-process runtime lock.
  // The advisory lock is the real owner; this boolean is an admission signal for
  // DB/runtime writers. Re-setting an old `true` is intentional crash recovery:
  // no live teardown can own it while this caller holds the advisory lock.
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

    // The live-row update failed for some other reason — surface it loudly.
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
  // already running". Runtime adapters own their command deadlines; if this
  // process dies, Postgres releases the advisory lock and the next caller safely
  // reclaims the stale boolean while holding that lock.
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

    // ── Step 0: find the projects this app is linked INTO. ───────────────
    // `project_connection.sourceProjectId` is ON DELETE RESTRICT, so those links
    // have to go before the row can drop — we unlink them near the END (see
    // stepUnlinkConsumers), but read them here so the list is captured while the
    // graph is still whole.
    //
    // try/catch, not `.catch()`: the repo lookup can throw SYNCHRONOUSLY (a
    // partially-stubbed `repos` in a unit test), which a promise `.catch` never
    // sees — and a read that explodes must not take the delete down. Unreadable
    // → the FK still protects the row (stepDeleteRow fails loudly instead).
    let consumerLinks: ConsumerLink[] = [];
    try {
      consumerLinks = (await repos.projectConnection.listBySource(projectId)) as ConsumerLink[];
    } catch {
      /* unreadable — stepDeleteRow surfaces the FK error if it mattered */
    }

    // Record-only ("soft") delete: keep the server workload + data, drop just
    // the Openship record. NEVER honored for a cloud project — its resources
    // live on Oblien and must be reclaimed; this is the security boundary, not
    // the UI toggle. (CLOUD_MODE = the SaaS itself, where nothing is "kept".)
    const recordOnly = !!opts.recordOnly && !project.cloudWorkspaceId && !env.CLOUD_MODE;

    // ── Step 1: Cancel in-flight work (force=true or forceOrphan). ───────
    // Cancellation only requests/records the stop here. Runtime cleanup happens
    // after confirmed worker quiescence below; record-only then skips that later
    // cleanup entirely.
    if (opts.force || opts.forceOrphan) {
      const quiesced = await stepCancelInFlight(ctx, projectId, push);
      if (!quiesced) {
        // A build/backup that is still running can provision or mutate resources
        // after the manifest snapshot. Neither force nor force-orphan is allowed
        // to turn that race into an untracked leak: keep the row and retry after
        // cancellation has actually reached a terminal state.
        push({
          step: "delete_db_row",
          status: "skipped",
          details: "kept: in-flight work did not quiesce",
        });
        return finalize(steps, false);
      }
    } else {
      // Authoritative graceful gate, deliberately INSIDE the deletion lock.
      // The controller used to precheck before claim, leaving a window where a
      // queued deployment could appear between the read and manifest snapshot.
      const active = await getActiveProjectState(projectId);
      if (active.blocking) {
        push({
          step: "cancel_in_flight",
          status: "failed",
          details: active.summary,
          error: "Active work must finish or be cancelled before deletion",
        });
        push({
          step: "delete_db_row",
          status: "skipped",
          details: "kept: project still has active work",
        });
        return finalize(steps, false, "active_work", { active });
      }
      push({ step: "cancel_in_flight", status: "skipped", details: "nothing in flight" });
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
      const runtimeCleanup = await stepRuntimeCleanup(
        project,
        opts.wipeVolumes ?? false,
        opts.forceOrphan ?? false,
        push,
      );
      const orphanCandidates = runtimeCleanup.orphans;

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
        const webmailFailed = steps.some(
          (step) => step.step === "webmail" && step.status === "failed",
        );
        return finalize(steps, false, undefined, {
          canForceOrphan: runtimeCleanup.forceOrphanEligible && !webmailFailed,
        });
      }

      // About to drop the row — persist any orphaned resources FIRST so the GC
      // sweep can still find + reclaim them after the project row (their only
      // record) is gone. Only happens on the row-dropping path: a kept row keeps
      // the resources tracked via the project itself, so no orphan record needed.
      try {
        orphaned = await persistOrphans(ctx.organizationId, projectId, orphanCandidates);
        if (orphanCandidates.length > 0) {
          push({
            step: "persist_orphans",
            status: "ok",
            details: `${orphaned.length} resource(s) queued for deferred cleanup`,
          });
        }
      } catch (err) {
        // Dropping the project without a durable retry record would turn a
        // reachable-later vhost/workload into an untracked permanent orphan.
        // Keep the row and deletion lock semantics intact so the whole operation
        // can be retried safely.
        push({
          step: "persist_orphans",
          status: "failed",
          error: safeErrorMessage(err),
        });
        push({
          step: "delete_db_row",
          status: "skipped",
          details: "kept: deferred cleanup resources could not be recorded",
        });
        return finalize(steps, false);
      }
    }

    // ── Step 4b: unlink this app from every project it was wired into. ───
    // The LAST thing before the row drops, deliberately: the atomicity gate above
    // can still keep the row (unreachable server), and a project stripped of its
    // env var while the app it points at is still alive is the one outcome nobody
    // asked for. A failure here keeps the row too — the RESTRICT FK would refuse
    // the drop anyway.
    const unlink = await stepUnlinkConsumers(consumerLinks, push);
    if (!unlink.ok) {
      return finalize(steps, false, undefined, { orphaned, unlinked: unlink.unlinked });
    }

    // ── Step 5: Drop the DB row. FK CASCADE on project.id sweeps
    //   deployment, service, env_var, domain, backup_policy.
    rowDeleted = await stepDeleteRow(projectId, project.groupId, push);

    return finalize(steps, rowDeleted, undefined, { orphaned, unlinked: unlink.unlinked });
  } finally {
    // Lock released on every non-deleting exit so a retry is always possible.
    if (!rowDeleted) {
      await repos.project.clearDeletionInProgress(projectId).catch(() => {});
    }
  }
}

/**
 * Serialize the full destructive lifecycle with every post-commit route writer.
 * Keeping the advisory lock until the row is either deleted or unlocked means a
 * late PATCH can never recreate a vhost after teardown's manifest/cleanup pass.
 */
export function teardownProject(
  ctx: RequestContext,
  projectId: string,
  opts: TeardownOptions,
): Promise<TeardownResult> {
  return withProjectRuntimeLock(projectId, () => teardownProjectLocked(ctx, projectId, opts));
}

function finalize(
  steps: TeardownStep[],
  rowDeleted: boolean,
  rejection?: TeardownRejectionKind,
  extra: {
    orphaned?: OrphanedResourceSummary[];
    unlinked?: UnlinkedConsumerSummary[];
    canForceOrphan?: boolean;
    active?: PreflightActiveState;
  } = {},
): TeardownResult {
  const unrecoverable = steps.filter((s) => s.status === "failed");
  return {
    ok: unrecoverable.length === 0,
    rowDeleted,
    steps,
    unrecoverable,
    orphaned: extra.orphaned ?? [],
    unlinked: extra.unlinked ?? [],
    canForceOrphan: extra.canForceOrphan ?? false,
    ...(extra.active !== undefined ? { active: extra.active } : {}),
    ...(rejection !== undefined ? { rejection } : {}),
  };
}

// ─── Linked projects ──────────────────────────────────────────────────────────

/** A `project_connection` row seen from the SOURCE side — one project this app
 *  was linked into. */
interface ConsumerLink {
  id: string;
  targetProjectId: string;
  envKey: string;
  mode: string;
}

// ─── Step implementations ─────────────────────────────────────────────────────

/**
 * Unlink this app from every project it was wired into.
 *
 * Deleting a linked app is allowed to break the link — that IS the delete. The
 * consuming projects keep running (their containers, data and services are never
 * touched); they just lose the injected connection env var, so the caller tells
 * the user which ones to redeploy.
 */
async function stepUnlinkConsumers(
  links: ConsumerLink[],
  push: (s: TeardownStep) => void,
): Promise<{ ok: boolean; unlinked: UnlinkedConsumerSummary[] }> {
  const unlinked: UnlinkedConsumerSummary[] = [];
  if (links.length === 0) return { ok: true, unlinked };

  // Dynamic import keeps the connection service's deploy-pipeline imports out of
  // this module's static graph — same reason applyConnectionToTarget does it.
  const { unlinkConsumersOfSource } = await import("./project-connection.service");
  const result = await unlinkConsumersOfSource(links);
  unlinked.push(...result.unlinked);

  if (result.errors.length > 0) {
    push({
      step: "unlink_consumers",
      status: "failed",
      details: `${unlinked.length}/${links.length} unlinked`,
      error: result.errors.join("; "),
    });
    return { ok: false, unlinked };
  }
  push({
    step: "unlink_consumers",
    status: "ok",
    details: `${unlinked.length} project link(s) removed`,
  });
  return { ok: true, unlinked };
}

async function stepCancelInFlight(
  ctx: RequestContext,
  projectId: string,
  push: (s: TeardownStep) => void,
): Promise<boolean> {
  const before = await getActiveProjectState(projectId);
  if (!before.blocking) {
    push({ step: "cancel_in_flight", status: "skipped", details: "nothing in flight" });
    return true;
  }

  // Diagnostic notes are surfaced only if work remains after the grace window.
  // A capture may finish naturally (or a restore may acknowledge cooperatively),
  // in which case confirmed quiescence is success even if a request raced.
  const cancellationNotes: string[] = [];

  // Cancel each active deployment — cancelBuildSession aborts the build,
  // tears down half-provisioned containers/images, and marks the row
  // cancelled. Cleanup is deferred until the worker lease is gone so teardown
  // never races an executing deploy. Best-effort: a deployment
  // that has already finished between listing and cancelling will throw
  // ForbiddenError, which we ignore — the next quiesce poll will pick that up.
  for (const depId of before.activeDeploymentIds) {
    try {
      // Never tear provisioned resources down from the cancellation call while
      // its worker lease is still active. The canonical project manifest does
      // that only after the poll below observes the worker's outer-finally
      // acknowledgement. Record-only deletion needs the same flag for its own
      // stronger promise that server resources are kept.
      await cancelBuildSession(depId, { keepProvisioned: true });
    } catch (err) {
      cancellationNotes.push(`deployment ${depId}: ${safeErrorMessage(err)}`);
    }
  }

  // A queued backup has no worker to abort, so cancel it with the same CAS the
  // worker claims. Once deletion owns the project admission barrier no later
  // worker can cross it. A capture that already holds an execution lease is left
  // alone: relabelling it would not stop snapshot/upload I/O, and the poll below
  // must keep the project until that worker genuinely acknowledges completion.
  for (const runId of before.activeBackupRunIds) {
    try {
      const cancelled = await repos.backupRun.cancelQueuedBeforeExecution(
        runId,
        projectId,
        ctx.organizationId,
      );
      if (!cancelled) {
        cancellationNotes.push(
          `backup_run ${runId}: active backup capture cannot be cancelled safely`,
        );
      }
    } catch (err) {
      cancellationNotes.push(`backup_run ${runId}: ${safeErrorMessage(err)}`);
    }
  }

  // Restores go through the orchestrator, not a bare status flip. `cancel` fires the
  // in-process AbortController, so the extract STOPS WRITING before the runtime cleanup
  // below starts destroying the volumes underneath it; a flip alone left the two racing,
  // and the FSM row said `cancelled` while tar kept unpacking. It also sets the durable
  // flag, which is what covers an apply running on another node, and it never throws for
  // a row that finished between the listing and here.
  //
  // An `applying` restore comes back still `applying` on purpose — the orchestrator
  // gives it a cooperative window. The quiesce poll below IS that window. We never
  // force-terminalize an unanswered apply: that changes only the row while extraction
  // may still be writing, so resource teardown must remain blocked.
  for (const restoreId of before.activeBackupRestoreIds) {
    try {
      const outcome = await restoreOrchestrator.cancel(ctx, restoreId);
      if (outcome.status !== "cancelled") {
        cancellationNotes.push(
          `backup_restore ${restoreId}: cancellation pending (${outcome.status})`,
        );
      }
    } catch (err) {
      cancellationNotes.push(`backup_restore ${restoreId}: ${safeErrorMessage(err)}`);
    }
  }

  // Docker migration can stop source containers, stream volumes, and deploy on
  // another host. Its orchestrator cancellation performs the real rollback and
  // writes a terminal row only after source restoration/target cleanup. Request
  // that cooperative rollback, then let the shared poll below require the
  // durable terminal acknowledgement. Parked partial/cutover states may refuse
  // cancellation; in that case deletion safely times out and tells the operator
  // to resolve the migration first.
  if (before.activeMigrationIds.length > 0) {
    const { migrationOrchestrator } = await import("../migration/migration.orchestrator");
    for (const migrationId of before.activeMigrationIds) {
      try {
        const outcome = await migrationOrchestrator.cancel(migrationId, ctx.organizationId);
        if (!outcome.ok) {
          cancellationNotes.push(`migration ${migrationId}: ${outcome.error}`);
        }
      } catch (err) {
        cancellationNotes.push(`migration ${migrationId}: ${safeErrorMessage(err)}`);
      }
    }
  }

  // Brief poll for quiescence — gives the runner a window to notice the
  // status flip before runtime cleanup tries to destroy a container the
  // runner is still touching. If the window expires, teardown stops before
  // manifest collection or any resource mutation.
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
      error:
        `Timed out waiting for quiescence after ${QUIESCE_TIMEOUT_MS}ms` +
        (cancellationNotes.length > 0 ? `; ${cancellationNotes.join("; ")}` : ""),
    });
    return false;
  }

  push({
    step: "cancel_in_flight",
    status: "ok",
    details:
      `confirmed quiescent after requesting cancellation of ` +
      `${before.activeDeploymentIds.length} deployment(s) and ` +
      `${before.activeBackupRestoreIds.length} restore(s), ` +
      `${before.activeMigrationIds.length} migration(s)` +
      (before.activeBackupRunIds.length > 0
        ? `; cancelled or waited for ${before.activeBackupRunIds.length} backup capture(s)`
        : ""),
  });
  return true;
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
    await deleteGitHubWebhook(ctx, project.gitOwner, project.gitRepo, project.webhookId);
    push({ step: "github_webhook", status: "ok", details: `hook ${project.webhookId}` });
  } catch (err) {
    // GitHub returns 404 when the hook is already gone — treat as a
    // skip, not a failure. Anything else (auth, network) bubbles up.
    const msg = safeErrorMessage(err);
    if (msg.toLowerCase().includes("not found") || msg.includes("404")) {
      push({ step: "github_webhook", status: "skipped", details: "already gone" });
      return;
    }
    // The actor may delete the PROJECT (project:admin) without holding write on the
    // REPO — deleting a repo webhook needs the latter, and borrowing a wider
    // credential to do it anyway is the escalation GHSA-hp2g-hw7g-f3vm reported.
    // Not touching their repo is the correct outcome, so report it as a skip with
    // the reason rather than failing the teardown into a 207.
    if ((err as { code?: unknown } | null)?.code === "GITHUB_ACCESS_DENIED") {
      push({
        step: "github_webhook",
        status: "skipped",
        details: "no write access to the repo — hook left in place",
      });
      return;
    }
    push({ step: "github_webhook", status: "failed", error: msg });
  }
}

/** A remote resource to record for GC (server unreachable, or force-orphaned). */
interface OrphanCandidate {
  serverId: string | null;
  targetKey: string | null;
  resourceType: string;
  ref: string;
  label: string;
  runtimeMode: string | null;
  payload?: Record<string, unknown> | null;
}

function orphanCandidateKey(
  candidate: Pick<
    OrphanCandidate,
    "serverId" | "targetKey" | "runtimeMode" | "resourceType" | "ref"
  >,
): string {
  return [
    candidate.serverId ?? "",
    candidate.targetKey ?? "",
    candidate.runtimeMode ?? "",
    candidate.resourceType,
    candidate.ref,
  ].join("\0");
}

interface RuntimeCleanupOutcome {
  orphans: OrphanCandidate[];
  /** The manifest was collected and destruction of reachable resources failed. */
  forceOrphanEligible: boolean;
}

async function stepRuntimeCleanup(
  project: Project,
  wipeVolumes: boolean,
  forceOrphan: boolean,
  push: (s: TeardownStep) => void,
): Promise<RuntimeCleanupOutcome> {
  const orphans: OrphanCandidate[] = [];
  const orphanKeys = new Set<string>();
  const addOrphan = (candidate: OrphanCandidate) => {
    const key = orphanCandidateKey(candidate);
    if (orphanKeys.has(key)) return;
    orphanKeys.add(key);
    orphans.push(candidate);
  };
  let manifest;
  try {
    manifest = await collectProjectManifest(project, { wipeVolumes });
  } catch (err) {
    push({
      step: "runtime_cleanup",
      status: "failed",
      error: `Manifest collection failed: ${safeErrorMessage(err)}`,
    });
    return { orphans, forceOrphanEligible: false };
  }

  if (
    manifest.resources.length === 0 &&
    (manifest.routeContexts?.length ?? 0) === 0 &&
    (manifest.unreachableRouteTargets?.length ?? 0) === 0
  ) {
    push({ step: "runtime_cleanup", status: "skipped", details: "no resources" });
    return { orphans, forceOrphanEligible: false };
  }

  // ENFORCED DELETE: resources on an UNREACHABLE server are never destroyed
  // inline (that inline destroy is the ~81s hang). Orphan them for the GC sweep
  // to reclaim once the server is back, and let the delete proceed. Everything
  // else goes through the normal destroy path.
  const unreachable = manifest.resources.filter((r) => r.type === "unreachable");
  const destroyable = manifest.resources.filter((r) => r.type !== "unreachable");

  for (const r of unreachable) {
    addOrphan({
      serverId: r.serverId ?? null,
      targetKey: r.targetKey ?? null,
      resourceType:
        r.deferredResourceType ?? (r.runtimeMode === "cloud" ? "cloud_workspace" : "container"),
      ref: r.ref,
      label: r.label,
      runtimeMode: r.runtimeMode ?? null,
      payload: r.payload ?? null,
    });
  }

  // An unreachable historical target has no live routing/edge adapter to put in
  // `routeContexts`, but its vhost and detached claims still exist. Record the
  // exact server now; GC will resolve that target, remove every known hostname,
  // and only then run a fresh claim convergence when the host returns.
  const routeResources = destroyable.filter((resource) => resource.type === "route");
  for (const target of manifest.unreachableRouteTargets ?? []) {
    for (const route of routeResources) {
      addOrphan({
        serverId: target.serverId,
        targetKey: target.targetKey,
        resourceType: "route",
        ref: route.ref,
        label: `${route.label} (server:${target.serverId})`,
        runtimeMode: target.runtimeMode,
      });
    }
    if (routeResources.length === 0) {
      // A project can own published host ports without owning a hostname. There
      // is then no route row to carry claim convergence into GC, so model the
      // detached claims themselves instead of leaking their reservations.
      addOrphan({
        serverId: target.serverId,
        targetKey: target.targetKey,
        resourceType: "host_port_claims",
        ref: `server:${target.serverId}`,
        label: `host-port claims on server:${target.serverId}`,
        runtimeMode: target.runtimeMode,
      });
    }
  }

  const orphanNote = unreachable.length
    ? `; ${unreachable.length} orphaned (server unreachable)`
    : "";

  if (destroyable.length === 0 && (manifest.routeContexts?.length ?? 0) === 0) {
    // Nothing reachable to destroy — only unreachable orphans. The delete
    // proceeds (row drops); GC reclaims the orphans later.
    const hasDeferredCleanup = orphans.length > 0;
    push({
      step: "runtime_cleanup",
      status: hasDeferredCleanup ? "ok" : "skipped",
      details: hasDeferredCleanup
        ? `${orphans.length} resource(s) queued for deferred cleanup`
        : "no resources",
    });
    return { orphans, forceOrphanEligible: false };
  }

  // Force-orphan short-circuit: the operator chose "delete from storage anyway",
  // so DON'T attempt the inline SSH destroy at all (that's the call that can hang
  // ~80s on a slow/failing runtime and is why the escape felt stuck). Record
  // every reachable resource on its collected historical target for the GC sweep
  // and let the row drop now. The latest-deployment fallback exists only for an
  // older/test manifest that predates per-resource target identity.
  if (forceOrphan) {
    const preexistingOrphans = orphans.length;
    const hasRouteTargets =
      (manifest.routeContexts?.length ?? 0) > 0 ||
      (manifest.unreachableRouteTargets?.length ?? 0) > 0;
    const needsLegacyTarget = destroyable.some(
      (resource) => !resource.runtimeMode && (resource.type !== "route" || !hasRouteTargets),
    );
    const legacyTarget = needsLegacyTarget ? await resolvePrimaryTarget(project.id) : null;
    if (routeResources.length === 0) {
      for (const routeTarget of manifest.routeContexts ?? []) {
        addOrphan({
          serverId: routeTarget.serverId,
          targetKey: routeTarget.key,
          resourceType: "host_port_claims",
          ref: routeTarget.key,
          label: `host-port claims on ${routeTarget.key}`,
          runtimeMode: routeTarget.runtimeMode,
        });
      }
    }
    for (const r of destroyable) {
      if (r.type === "route") {
        // A migrated project can have the same vhost on several physical
        // targets. Record one retry per target; collapsing them onto the latest
        // server would let GC declare the other copies reclaimed without ever
        // touching them.
        for (const routeTarget of manifest.routeContexts ?? []) {
          addOrphan({
            serverId: routeTarget.serverId,
            targetKey: routeTarget.key,
            resourceType: "route",
            ref: r.ref,
            label: `${r.label} (${routeTarget.key})`,
            runtimeMode: routeTarget.runtimeMode,
          });
        }
        // Unreachable targets were fanned out above. Only a legacy manifest with
        // neither target list needs the old latest-target fallback.
        if (
          (manifest.routeContexts?.length ?? 0) > 0 ||
          (manifest.unreachableRouteTargets?.length ?? 0) > 0
        ) {
          continue;
        }
      }
      addOrphan({
        serverId: r.serverId ?? legacyTarget?.serverId ?? null,
        targetKey: r.targetKey ?? null,
        resourceType: r.type === "unreachable" ? (r.deferredResourceType ?? "container") : r.type,
        ref: r.ref,
        label: r.label,
        runtimeMode:
          r.runtimeMode ??
          (r.runtime?.name === "cloud"
            ? "cloud"
            : r.runtime?.name === "bare"
              ? "bare"
              : r.runtime?.name === "docker"
                ? "docker"
                : (legacyTarget?.runtimeMode ?? null)),
        payload: r.payload ?? null,
      });
    }
    push({
      step: "runtime_cleanup",
      status: "ok",
      details:
        `${orphans.length - preexistingOrphans} resource(s) force-orphaned ` +
        `(storage-only delete)${orphanNote}`,
    });
    // This path deliberately never calls executeCleanup, so the transports the
    // manifest is holding have to be released here instead.
    disposeManifestRuntimes(manifest);
    return { orphans, forceOrphanEligible: false };
  }

  // A named volume's identity lives only in its container mount metadata. Once
  // the container phase succeeds, a later volume failure cannot rediscover it
  // on retry. Checkpoint each volume before the first destructive operation;
  // GC defers these rows while the project exists and replays them after a later
  // successful/force delete. A clean inline run removes the checkpoints again.
  let volumeCheckpointIds: string[] = [];
  try {
    volumeCheckpointIds = await checkpointVolumeCleanup(project, destroyable);
  } catch (err) {
    disposeManifestRuntimes(manifest);
    push({
      step: "runtime_cleanup",
      status: "failed",
      error: `Could not checkpoint volume cleanup: ${safeErrorMessage(err)}`,
    });
    return { orphans, forceOrphanEligible: false };
  }

  // `organizationId` must be carried through: this call REBUILDS the manifest
  // object from a filtered resource list, and dropping the field silently skipped
  // the Cloud edge-route release for every torn-down project — leaving the free
  // `*.opsh.io` URL resolving and its globally-unique slug reserved against an org
  // that no longer has the project.
  const result = await executeCleanup({
    projectId: manifest.projectId,
    organizationId: manifest.organizationId,
    resources: destroyable,
    runtimes: manifest.runtimes,
    routeContexts: manifest.routeContexts,
    unreachableRouteTargets: manifest.unreachableRouteTargets,
  });
  const realFailures = result.failed;
  const details =
    `${result.succeeded}/${result.total} ok` + (wipeVolumes ? " (volumes wiped)" : "") + orphanNote;

  if (realFailures.length === 0) {
    await Promise.allSettled(volumeCheckpointIds.map((id) => repos.orphanedResource.delete(id)));
    push({ step: "runtime_cleanup", status: "ok", details });
    return { orphans, forceOrphanEligible: false };
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
  return { orphans, forceOrphanEligible: true };
}

async function checkpointVolumeCleanup(
  project: Project,
  resources: Awaited<ReturnType<typeof collectProjectManifest>>["resources"],
): Promise<string[]> {
  const volumes = resources.filter((resource) => resource.type === "volume");
  if (volumes.length === 0) return [];

  const existing = await repos.orphanedResource.listByProject(project.id);
  const existingByKey = new Map(
    existing
      .filter((row) => row.resourceType === "volume")
      .map((row) => [orphanCandidateKey(row), row] as const),
  );
  const checkpointIds: string[] = [];
  const createdIds: string[] = [];
  try {
    for (const resource of volumes) {
      const candidate: OrphanCandidate = {
        serverId: resource.serverId ?? null,
        targetKey: resource.targetKey ?? null,
        resourceType: "volume",
        ref: resource.ref,
        label: resource.label,
        runtimeMode: resource.runtimeMode ?? "docker",
      };
      const prior = existingByKey.get(orphanCandidateKey(candidate));
      if (prior) {
        checkpointIds.push(prior.id);
        continue;
      }
      const created = await repos.orphanedResource.create({
        organizationId: project.organizationId,
        projectId: project.id,
        ...candidate,
        payload: null,
      });
      if (!created?.id) throw new Error(`No checkpoint id returned for ${resource.label}`);
      createdIds.push(created.id);
      checkpointIds.push(created.id);
      existingByKey.set(orphanCandidateKey(candidate), created);
    }
    return checkpointIds;
  } catch (err) {
    await Promise.allSettled(createdIds.map((id) => repos.orphanedResource.delete(id)));
    throw err;
  }
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

/** Persist every orphan candidate before the project row may disappear.
 *
 * This is logically all-or-nothing: if one insert fails, best-effort roll back
 * the rows created by this attempt and reject the teardown. The GC also refuses
 * to touch any orphan whose project row still exists, so even an unsuccessful
 * rollback cannot reclaim a live project's resources. */
async function persistOrphans(
  organizationId: string,
  projectId: string,
  candidates: OrphanCandidate[],
): Promise<OrphanedResourceSummary[]> {
  const out: OrphanedResourceSummary[] = [];
  const createdIds: string[] = [];
  const existing = await repos.orphanedResource.listByProject(projectId);
  const existingKeys = new Set(existing.map(orphanCandidateKey));
  for (const c of candidates) {
    try {
      if (existingKeys.has(orphanCandidateKey(c))) {
        out.push({ ref: c.ref, label: c.label, serverId: c.serverId });
        continue;
      }
      const created = await repos.orphanedResource.create({
        organizationId,
        serverId: c.serverId,
        targetKey: c.targetKey,
        resourceType: c.resourceType,
        ref: c.ref,
        projectId,
        label: c.label,
        runtimeMode: c.runtimeMode,
        payload: c.payload ?? null,
      });
      if (created?.id) createdIds.push(created.id);
      existingKeys.add(orphanCandidateKey(c));
      out.push({ ref: c.ref, label: c.label, serverId: c.serverId });
    } catch (err) {
      await Promise.allSettled(createdIds.map((id) => repos.orphanedResource.delete(id)));
      throw new Error(`Failed to record deferred cleanup for ${c.label}: ${safeErrorMessage(err)}`);
    }
  }
  return out;
}

/**
 * The webmail's off-project leftovers: a proxy vhost on the MAIL server (not the
 * one this project ran on), and — for a pre-catalog webmail — a host state dir
 * and the mail-state block that held its session key. Everything else about the
 * app is an ordinary container + volume the runtime step already removed.
 *
 * Runs before `stepDeleteRow`, so the project's domain rows are still readable
 * here — which is how the proxy variant is told apart from a routed one.
 */
async function stepWebmailTeardown(
  project: Project,
  push: (s: TeardownStep) => void,
): Promise<void> {
  try {
    const details = await cleanupWebmailInstall(project);
    push(
      details
        ? { step: "webmail", status: "ok", details }
        : { step: "webmail", status: "skipped", details: "nothing webmail-specific" },
    );
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
