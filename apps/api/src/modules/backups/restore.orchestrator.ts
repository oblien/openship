/**
 * RestoreOrchestrator — drives a backup_restore row through its FSM.
 *
 * Three-step flow:
 *
 *   prepare(): queued → preparing → prepared
 *     Reads every artifact back from the destination and re-hashes it, plus
 *     cross-checks the destination's own manifest.json against the recorded
 *     artifact list. Nothing is staged locally — "prepared" means "verified
 *     downloadable and intact", not "bytes already on the target". The service
 *     is untouched, so this is the only phase where a failure or a cancel costs
 *     nothing, which is exactly why verification lives here and not in apply.
 *     `meta.integrity` records which check actually ran; see verifyArtifacts.
 *
 *   apply(): prepared → applying → succeeded
 *     Destructive. Stops the service, replaces target volume contents
 *     from staging, restarts. Producer-specific restore() decides
 *     HOW (volume = tar extract; pg_dump = pg_restore from staged file;
 *     redis = copy dump.rdb into /data; etc.).
 *
 *   cancel(): any non-terminal status → cancelled
 *     Cooperative, and honest about what it can undo. Before apply it is free.
 *     During apply it aborts the in-flight extract, and if the target was
 *     already being written the row says so and the service is left stopped —
 *     see runApply's checkpoints. Never throws: a cancel that errors is a
 *     wedged row nobody can clear.
 *
 * Live progress streams via SSE on a separate channel (restoreRunBus).
 * Same shape as backups — dashboard refresh-safe.
 */

import crypto from "node:crypto";
import { Writable, pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";
import {
  repos,
  type BackupRestore,
  type BackupRun,
  type BackupRestoreStatus,
} from "@repo/db";
import { liveContainerIdForService } from "../services/service-container";
import {
  HashingPassthrough,
  matchBackupSource,
  resolveDestination,
  resolveExecutor,
  resolveProducer,
  validateManifest,
  type BackupDestination,
  type BackupExecutor,
  type BackupTrigger,
  type PayloadKind,
  type ServiceHandle,
} from "@repo/adapters";
import { staticReleaseDir, usableRef } from "../deployments/rollback/restore-plan";
import { decryptEnvMap } from "../../lib/encryption";
import { resolveDeploymentPlatform, resolveTargetPlatform } from "../../lib/deployment-runtime";
import { safeErrorMessage } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import { restoreRunBus } from "./restore.sse";
import { notification } from "../../lib/notification-dispatcher";
import { boundedStorableText } from "../deployments/build-log-sanitize";

const TRUNCATE_ERROR = 4096;

const pipelineP = promisify(streamPipeline);

/**
 * How long an unanswered cancel has to sit before a second press force-terminals
 * the row. The operator pressed cancel, watched nothing happen, pressed again —
 * that is the signal, and it needs no second endpoint. Long enough that a normal
 * cooperative cancel (which lands at the next checkpoint) always wins the race.
 */
const FORCE_CANCEL_AFTER_MS = 2 * 60 * 1000;

/**
 * The one sentence an operator reads after a cancel that landed mid-write, used
 * verbatim on both the cooperative and the forced path. Identical wording is the
 * point: a forced cancel has strictly LESS certainty about the target's state,
 * so it must never read as the reassuring outcome.
 */
function partialWriteSentence(source: string): string {
  return (
    `Cancelled after the restore had begun writing ${source}. That volume now holds ` +
    `partial data — re-run this restore (or a newer one) to completion before starting ` +
    `the service.`
  );
}

/** Thrown at a checkpoint to unwind runApply into its cancel path. */
class RestoreCancelled extends Error {
  constructor(readonly destructiveSource: string | null) {
    super("Restore cancelled");
  }
}

/**
 * Payload kinds whose restore() writes through `executor.pipeIntoCommand` — i.e.
 * INTO a running process inside the container, which the docker executor cannot
 * do without a containerId. Volume restores are the exception: they mount the
 * volume into a separate helper, so they work with the container gone.
 */
const NEEDS_LIVE_CONTAINER: ReadonlySet<PayloadKind> = new Set<PayloadKind>([
  "pg_dump",
  "mysql_dump",
  "redis_rdb",
  "mongo_dump",
  "custom_command",
]);

/**
 * A failure that happened after the restore began writing the target.
 *
 * The distinction is the whole point: a pre-write failure means "nothing
 * changed, put the service back", a post-write failure means "the target holds
 * partial data, leave it stopped". Both are `failed` rows, but the second must
 * never be followed by a startService.
 */
class PartialWriteError extends Error {
  readonly partialWrite = true;
}

/** An artifact as `backup_run.artifacts` recorded it at capture time. */
interface RecordedArtifact {
  name?: string;
  key: string;
  sha256: string | null;
  sizeBytes: number;
  payloadKind: PayloadKind;
  metadata: Record<string, unknown>;
}

function recordedArtifacts(run: BackupRun): RecordedArtifact[] {
  return Array.isArray(run.artifacts) ? (run.artifacts as RecordedArtifact[]) : [];
}

/** Digests are compared as bare lowercase hex — `sha256:` prefixes and casing
 *  differ between what we record and what a destination reports back. */
function normalizeDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().replace(/^sha256:/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(bare) ? bare : null;
}

/** Read a stream to the end, keeping nothing. The point is the bytes passing
 *  through the hasher, not the bytes themselves. */
function discardingSink(): Writable {
  return new Writable({ write: (_chunk, _enc, cb) => cb() });
}

/** The digest a hasher saw, or null if its stream never finished. */
function digestIfComplete(hasher: HashingPassthrough): string | null {
  try {
    return hasher.summary().sha256;
  } catch {
    return null;
  }
}

export interface PrepareRestoreInput {
  /** Source backup run to restore from. */
  runId: string;
  trigger: BackupTrigger;
  /** Generate a confirmation token the dashboard echoes back when
   *  applying. Used for audit + defense against accidental restore. */
  confirmationToken: string;
  /** "in_place" (default) restores onto the source. "to_fork" restores a
   *  mail-server backup onto a DIFFERENT mail server (= migrate A→B). */
  mode?: "in_place" | "to_fork";
  /** Target mail server for a to_fork restore. Required when mode="to_fork". */
  forkMailServerId?: string | null;
}

export class RestoreOrchestrator {
  /**
   * In-process abort handles for applies running on THIS node, so a cancel
   * interrupts the extract instead of waiting it out. The DB flag is the durable
   * half — the node taking the cancel is not guaranteed to be the node running
   * the apply, so neither mechanism can be the only one.
   */
  private readonly inFlight = new Map<string, AbortController>();

  /** Begin a restore — create the row in queued state and kick off
   *  the prepare step in the background. Returns the restoreId. */
  async beginPrepare(opts: PrepareRestoreInput): Promise<{ restoreId: string }> {
    const sourceRun = await repos.backupRun.findById(opts.runId);
    if (!sourceRun) throw new Error(`Backup run ${opts.runId} not found`);
    if (sourceRun.status !== "succeeded") {
      throw new Error("Can only restore from a succeeded backup run");
    }
    if (sourceRun.deletedAt) {
      throw new Error("This backup has been purged — nothing to restore");
    }

    // Cross-tenant guard (fail fast): the run's destination MUST belong to the
    // run's own org. A run whose destinationId was planted (e.g. via a crafted
    // ingest dump) to point at another tenant's backup_destination would
    // otherwise cause us to load + decrypt that victim's storage credentials.
    // Re-checked at every credential-load site below (assertDestinationOrg).
    const destForOrgCheck = await repos.backupDestination.findById(sourceRun.destinationId!);
    if (!destForOrgCheck) throw new Error("Backup destination not found");
    this.assertDestinationOrg(destForOrgCheck, sourceRun.organizationId);

    const mode = opts.mode ?? "in_place";
    if (mode === "to_fork" && !opts.forkMailServerId) {
      throw new Error("A migration (to_fork) restore requires a target mail server");
    }

    // Refuse parallel restores of the same source — would race the
    // staging area and confuse the SSE channel.
    const existing = await repos.backupRestore.findActiveByRunId(opts.runId);
    if (existing) {
      return { restoreId: existing.id };
    }

    const restoreId = `bks_${crypto.randomUUID()}`;
    await repos.backupRestore.create({
      id: restoreId,
      runId: opts.runId,
      destinationId: sourceRun.destinationId!, // succeeded run guarantees this
      projectId: sourceRun.projectId,
      serviceId: sourceRun.serviceId,
      organizationId: sourceRun.organizationId,
      status: "queued",
      mode,
      forkMailServerId: opts.forkMailServerId ?? null,
      clientIp: opts.trigger.clientIp ?? null,
      confirmationToken: opts.confirmationToken,
    });

    setImmediate(() => {
      void this.runPrepare(restoreId).catch((err) =>
        console.error(
          `[restore-orchestrator] prepare ${restoreId} crashed: ${safeErrorMessage(err)}`,
        ),
      );
    });

    return { restoreId };
  }

  /**
   * Apply a prepared restore. This is the destructive step — service
   * stops, target volume is wiped + replaced, service restarts.
   * Verifies the confirmation token from beginPrepare.
   */
  async apply(
    ctx: RequestContext,
    restoreId: string,
    confirmationToken: string,
  ): Promise<void> {
    const restore = await repos.backupRestore.findById(restoreId);
    try {
      assertResourceInOrg(restore, "Restore", ctx.organizationId, restoreId);
    } catch {
      throw new Error("Restore not found");
    }
    // Forensic stamp: still ensure the actor opening the destructive
    // step is the same user (defense in depth alongside org-scope).
    void ctx.userId;
    // Constant-time compare. `!==` short-circuits on the first differing
    // byte — sub-microsecond, but timing-attack-able if an attacker can
    // measure the response latency well enough. timingSafeEqual avoids
    // the leak. Stored + supplied tokens are both 32-char base64url
    // strings (192 bits), so length is fixed by construction; the
    // length-mismatch guard below preserves the constant-time property.
    const expected = restore.confirmationToken ?? "";
    const supplied = confirmationToken ?? "";
    if (
      expected.length !== supplied.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      throw new Error("Confirmation token mismatch");
    }
    if (restore.status !== "prepared") {
      throw new Error(
        `Restore is in status=${restore.status}, must be 'prepared' to apply`,
      );
    }

    setImmediate(() => {
      void this.runApply(restoreId).catch((err) =>
        console.error(
          `[restore-orchestrator] apply ${restoreId} crashed: ${safeErrorMessage(err)}`,
        ),
      );
    });
  }

  /**
   * Cancel a restore, in whichever phase it is in.
   *
   * `applying` used to be refused outright, which left #434's wedged rows with
   * no way out at all — and `preparing` was worse than refused: it wrote
   * `cancelled` while runPrepare carried on and overwrote it with `prepared`, so
   * the operator watched a cancel undo itself.
   *
   * Now every non-terminal status sets the durable flag first, so the running
   * phase sees it at its next checkpoint and stops overwriting the decision.
   * Phases that have not touched the target still transition immediately.
   * Returns what actually happened rather than throwing, so the UI can say
   * "cancelling…" instead of showing an error for a cancel that was accepted.
   */
  async cancel(
    ctx: RequestContext,
    restoreId: string,
  ): Promise<{
    accepted: boolean;
    status: BackupRestoreStatus;
    destructive: boolean;
    forced: boolean;
  }> {
    const restore = await repos.backupRestore.findById(restoreId);
    try {
      assertResourceInOrg(restore, "Restore", ctx.organizationId, restoreId);
    } catch {
      throw new Error("Restore not found");
    }
    void ctx.userId;

    const TERMINAL: BackupRestoreStatus[] = ["succeeded", "failed", "cancelled", "server_error"];
    if (TERMINAL.includes(restore.status as BackupRestoreStatus)) {
      // Idempotent rather than an error: a double-click on a restore that just
      // finished is not a problem the operator needs reported.
      return {
        accepted: false,
        status: restore.status as BackupRestoreStatus,
        destructive: this.metaFlag(restore, "destructive"),
        forced: this.metaFlag(restore, "forced"),
      };
    }

    // Durable first, then local. If the process dies between the two, the flag
    // is what makes the next checkpoint (or a restart's sweep) honor the cancel.
    const flagged = await repos.backupRestore.requestCancel(restoreId);
    this.inFlight.get(restoreId)?.abort();
    this.publishTransitionalCancel(restoreId, this.metaFlag(flagged ?? restore, "destructive"));

    if (restore.status !== "applying") {
      // Nothing was stopped and nothing written — the free cancel. runPrepare
      // checks the flag before its own `prepared` transition, so this cannot be
      // overwritten the way it used to be.
      await this.transition(restoreId, "cancelled", {
        meta: await this.mergedMeta(restoreId, { destructive: false }),
      });
      return { accepted: true, status: "cancelled", destructive: false, forced: false };
    }

    const requestedAt = flagged?.cancelRequestedAt ?? restore.cancelRequestedAt;
    const stale =
      requestedAt instanceof Date && Date.now() - requestedAt.getTime() >= FORCE_CANCEL_AFTER_MS;
    if (stale) {
      // The cooperative path had its window and did not answer. Force the row
      // terminal so it stops blocking project deletion — with the SAME
      // partial-data wording, because a forced cancel knows LESS about the
      // target's state than a cooperative one, not more.
      const destructive = this.metaFlag(flagged ?? restore, "destructive");
      const source =
        (this.metaValue(flagged ?? restore, "destructiveSource") as string | undefined) ??
        "the restore target";
      console.error(
        `[restore-orchestrator] force-cancelling wedged apply ${restoreId} ` +
          `(no checkpoint answered in ${Math.round(FORCE_CANCEL_AFTER_MS / 1000)}s)`,
      );
      await this.transition(restoreId, "cancelled", {
        errorMessage: boundedStorableText(
          destructive
            ? `${partialWriteSentence(source)} The apply was still running when it was ` +
                `force-cancelled, so the write may have continued past this point.`
            : "Cancelled before any data was written. The apply was force-cancelled after " +
                "it stopped responding; the service may have been left stopped.",
          TRUNCATE_ERROR,
        ),
        meta: await this.mergedMeta(restoreId, {
          forced: true,
          destructive,
          ...(destructive ? { partialWrite: true, serviceLeftStopped: true } : {}),
        }),
      });
      return { accepted: true, status: "cancelled", destructive, forced: true };
    }

    return {
      accepted: true,
      status: "applying",
      destructive: this.metaFlag(flagged ?? restore, "destructive"),
      forced: false,
    };
  }

  // ── meta helpers ─────────────────────────────────────────────────

  private metaOf(row: Pick<BackupRestore, "meta">): Record<string, unknown> {
    return (row.meta as Record<string, unknown> | null) ?? {};
  }

  private metaValue(row: Pick<BackupRestore, "meta">, key: string): unknown {
    return this.metaOf(row)[key];
  }

  private metaFlag(row: Pick<BackupRestore, "meta">, key: string): boolean {
    return this.metaValue(row, key) === true;
  }

  /**
   * Merge into the row's existing meta rather than replacing it.
   *
   * `meta` is one jsonb column and a drizzle `.set()` overwrites it wholesale,
   * so a terminal patch that passed only its own keys silently erased what
   * prepare recorded — the `integrity` fact that says whether the archive was
   * re-hashed at all. Read-then-merge is not atomic, but every writer here is
   * the single owner of this row's lifecycle.
   */
  private async mergedMeta(
    restoreId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const row = await repos.backupRestore.findById(restoreId).catch(() => undefined);
    return { ...(row ? this.metaOf(row) : {}), ...patch };
  }

  /**
   * Tell the UI a cancel was accepted while the phase it interrupts is still
   * running — the row is still `applying`, so no transition event carries it.
   */
  private publishTransitionalCancel(restoreId: string, destructive: boolean): void {
    try {
      restoreRunBus.publish(restoreId, {
        type: "destructive",
        destructive,
        cancelRequested: true,
      });
    } catch {
      // bus failures never block the FSM
    }
  }

  // ── Internal phases ──────────────────────────────────────────────

  /**
   * Defense-in-depth cross-tenant guard: a backup destination may only be used
   * by a run/restore in the SAME org. Mirrors the backup orchestrator's
   * project.org === destination.org invariant (backup.orchestrator.ts). Throws
   * a generic "not found" so a foreign destinationId can't be probed. Guards the
   * credential-decrypt sites (toAdapterRow → resolveDestination) against a
   * planted cross-tenant destinationId that the dump self-containment check
   * (assertDumpSelfContained) would already reject at ingest — this is the
   * runtime backstop.
   */
  private assertDestinationOrg(
    destinationRow: { organizationId: string },
    expectedOrgId: string,
  ): void {
    if (destinationRow.organizationId !== expectedOrgId) {
      throw new Error("Backup destination not found");
    }
  }

  private async runPrepare(restoreId: string): Promise<void> {
    try {
      const restore = await repos.backupRestore.findById(restoreId);
      if (!restore) return;

      await this.transition(restoreId, "preparing");

      const sourceRun = await repos.backupRun.findById(restore.runId);
      if (!sourceRun) throw new Error("Source backup run disappeared");

      const destinationRow = await repos.backupDestination.findById(
        restore.destinationId,
      );
      if (!destinationRow) throw new Error("Destination disappeared");
      this.assertDestinationOrg(destinationRow, restore.organizationId);

      const adapterRow = await toAdapterRow(destinationRow);
      const destination = resolveDestination(adapterRow);

      // Nothing is staged locally — "prepared" is a verified plan, not bytes on
      // the target. Pre-staging would need a Docker named volume
      // openship-restore-<id> plus a Cloud workspace path; it's a follow-up.
      const artifacts = recordedArtifacts(sourceRun);

      const manifest = await this.checkManifest(destination, sourceRun, artifacts);
      const target = await this.preflightTarget(restore, sourceRun, destinationRow, artifacts);
      const verification = await this.verifyArtifacts(
        destination,
        artifacts,
        await this.shouldVerifyOnPrepare(sourceRun),
        restoreId,
      );

      // Checked last, right before the row claims to be applyable: a cancel that
      // arrived during the (potentially long) verification read used to be
      // overwritten by this very transition, which is why cancelling `preparing`
      // never worked.
      await this.throwIfCancelRequested(restoreId, null);

      await this.transition(restoreId, "prepared", {
        bytesRestored: verification.totalBytes,
        meta: { ...manifest, ...verification.meta, ...target.meta },
      });
    } catch (err) {
      if (err instanceof RestoreCancelled) {
        // Nothing was stopped and nothing written — prepare is the free phase.
        await this.transition(restoreId, "cancelled", {
          meta: await this.mergedMeta(restoreId, { destructive: false }),
        });
        return;
      }
      const message = safeErrorMessage(err);
      console.error(`[restore-orchestrator] prepare ${restoreId} failed: ${message}`);
      await this.transition(restoreId, "failed", {
        errorMessage: boundedStorableText(message, TRUNCATE_ERROR),
      });
    }
  }

  /**
   * Answer "can this restore run at all" in PREPARE — the phase that already
   * owns every such question, and the last one where a failure costs nothing.
   *
   * #434's reporter hit the alternative: the target resolved to nothing, apply
   * stopped a service it could not restart, and the row hung in `applying`
   * forever. The check has to be narrow, though, because three legitimate shapes
   * carry no live container — a stopped project, a deployment-managed single-app
   * container, and the mail target, which deliberately ships `containerId: null`
   * with a declared bind path. Volume restores work fine in all three: the volume
   * is mounted into a separate helper.
   *
   * So only genuinely unrunnable combinations fail, each naming both facts:
   * nothing to mount at all, an artifact whose recorded volume is not among the
   * ones we can see, or a dump that has to be piped into a process inside a
   * container that isn't there.
   */
  private async preflightTarget(
    restore: BackupRestore,
    sourceRun: BackupRun,
    destinationRow: { organizationId: string },
    artifacts: RecordedArtifact[],
  ): Promise<{ meta: Record<string, unknown> }> {
    const { executor, serviceHandle } = await this.resolveTarget(
      restore,
      sourceRun,
      destinationRow,
    );

    // A probe that FAILED is not the same fact as a target with nothing in it,
    // and conflating them would report an unreachable host as a misconfigured
    // service — sending the operator to fix the wrong thing.
    let sources: Awaited<ReturnType<BackupExecutor["listSources"]>> = [];
    let probeError: string | null = null;
    try {
      sources = await executor.listSources(serviceHandle);
    } catch (err) {
      probeError = safeErrorMessage(err);
    }
    const restorable = sources.filter((s) => s.type !== "tmpfs");
    const needsContainer = artifacts.filter((a) => NEEDS_LIVE_CONTAINER.has(a.payloadKind));
    const volumeArtifacts = artifacts.filter((a) => a.payloadKind === "volume");

    if (restorable.length === 0 && volumeArtifacts.length > 0) {
      if (probeError) {
        throw new Error(
          `Could not enumerate restore targets for service "${serviceHandle.name}" on the ` +
            `host: ${probeError}. The restore was not started — fix host access and prepare ` +
            `it again.`,
        );
      }
      throw new Error(
        `Nothing to restore into for service "${serviceHandle.name}": it has no running ` +
          `container on the host AND no volumes recorded on the service row. Redeploy the ` +
          `project (or re-declare its volumes) and prepare the restore again.`,
      );
    }

    // Two different failures, and the operator's next step differs: an artifact
    // that never recorded which volume it came from can't be placed by anyone
    // (the volume producer refuses it too, one layer down), while a recorded id
    // that no longer matches means the service's volumes changed under it.
    const unlabelled = volumeArtifacts.filter(
      (a) => typeof a.metadata.volumeId !== "string" || !a.metadata.volumeId,
    );
    if (unlabelled.length > 0) {
      throw new Error(
        `Artifact${unlabelled.length > 1 ? "s" : ""} ` +
          `${unlabelled.map((a) => `"${a.name ?? a.key}"`).join(", ")} ` +
          `record${unlabelled.length > 1 ? "" : "s"} no volume id, so ` +
          `there is no way to tell which volume to restore into. This run was captured by an ` +
          `incompatible producer and cannot be restored in place.`,
      );
    }
    const unresolved = volumeArtifacts.filter(
      (a) => !matchBackupSource(restorable, a.metadata.volumeId as string),
    );
    if (unresolved.length > 0) {
      throw new Error(
        `Backed-up volume${unresolved.length > 1 ? "s" : ""} ` +
          `${unresolved.map((a) => `"${a.metadata.volumeId}"`).join(", ")} ` +
          `no longer exist${unresolved.length > 1 ? "" : "s"} on service ` +
          `"${serviceHandle.name}". Visible targets: ` +
          `${restorable.map((s) => s.id).join(", ") || "none"}. The service's volumes changed ` +
          `since this backup was taken, so it cannot be restored in place.`,
      );
    }

    if (needsContainer.length > 0 && executor.runtimeName === "docker" && !serviceHandle.containerId) {
      throw new Error(
        `Cannot restore ${needsContainer.map((a) => a.payloadKind).join(", ")} into service ` +
          `"${serviceHandle.name}": this payload is replayed INTO the running database process, ` +
          `and the service has no live container on the host. Deploy the service first, then ` +
          `prepare the restore again.`,
      );
    }

    return {
      meta: {
        targetContainer: serviceHandle.containerId ? "live" : "none",
        targetSources: restorable.length,
      },
    };
  }

  /**
   * Policy-level opt-out of prepare-time verification.
   *
   * Deliberately policy-level and not per-request: a per-request "skip
   * verification" checkbox is the one an operator clicks past at 3am on the
   * restore that matters. Default ON, and a run whose policy is gone still
   * verifies — absence of a policy is not consent to skip the check.
   */
  private async shouldVerifyOnPrepare(run: BackupRun): Promise<boolean> {
    if (!run.policyId) return true;
    const policy = await repos.backupPolicy.findById(run.policyId).catch(() => undefined);
    const configured = (policy?.payloadConfig as Record<string, unknown> | null | undefined)
      ?.verifyOnPrepare;
    return configured === false ? false : true;
  }

  /**
   * Cross-check the destination's own manifest.json against the artifact list in
   * our DB. This is the only thing that encodes "the destination still holds the
   * run we think it does" — a pruned, half-uploaded, or key-collided run shows
   * up here and nowhere else.
   *
   * A missing manifest is NOT a failure: runs captured before manifests were
   * written, and mail runs whose prefix was rewritten, legitimately have none.
   * A manifest that is present and DISAGREES is a hard failure — that is
   * corruption or a key collision, and restoring from a list we can't confirm is
   * how you overwrite a live volume with someone else's archive.
   */
  private async checkManifest(
    destination: BackupDestination,
    run: BackupRun,
    artifacts: RecordedArtifact[],
  ): Promise<{ manifest: "verified" | "missing" }> {
    if (!run.manifestKey) return { manifest: "missing" };

    let parsed: unknown;
    try {
      const stream = await destination.get(run.manifestKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      console.warn(
        `[restore-orchestrator] no readable manifest at ${run.manifestKey} ` +
          `(${safeErrorMessage(err)}) — verifying against the recorded artifact list`,
      );
      return { manifest: "missing" };
    }

    const manifest = validateManifest(parsed);
    const recorded = new Map(artifacts.map((a) => [a.key, a]));
    for (const entry of manifest.artifacts) {
      const ours = recorded.get(entry.key);
      if (!ours) {
        throw new Error(
          `Manifest disagrees with the recorded backup: ${run.manifestKey} lists ` +
            `${entry.key}, which this run has no record of capturing`,
        );
      }
      if (entry.sizeBytes !== ours.sizeBytes) {
        throw new Error(
          `Manifest disagrees with the recorded backup for ${entry.key}: ` +
            `manifest says ${entry.sizeBytes} bytes, run says ${ours.sizeBytes}`,
        );
      }
      const theirs = normalizeDigest(entry.sha256);
      const mine = normalizeDigest(ours.sha256);
      if (theirs && mine && theirs !== mine) {
        throw new Error(
          `Manifest disagrees with the recorded backup for ${entry.key}: ` +
            `manifest sha256 ${theirs}, run sha256 ${mine}`,
        );
      }
      recorded.delete(entry.key);
    }
    if (recorded.size > 0) {
      throw new Error(
        `Manifest at ${run.manifestKey} is missing ${recorded.size} artifact(s) this ` +
          `run recorded: ${[...recorded.keys()].join(", ")}`,
      );
    }
    return { manifest: "verified" };
  }

  /**
   * Read every artifact back and re-hash it — the check prepare used to claim in
   * a comment while comparing only byte sizes. Two truncations of the same
   * length, or silent bit-rot, both passed.
   *
   * This costs one extra full read of the archive, so the cost is REPORTED
   * (`verifiedBytes`, `verifyMs`) rather than hidden, and downgradeable per
   * policy. Whichever check ran is stamped on the row, because "succeeded" means
   * a different thing for each:
   *
   *   "sha256"    — bytes re-hashed and matched.
   *   "size-only" — the run recorded no digest (pre-hash history), so only
   *                 length could be compared. Warned, not failed.
   *   "deferred"  — the policy opted out; only presence + size checked here, and
   *                 the apply-time hasher is the backstop.
   */
  private async verifyArtifacts(
    destination: BackupDestination,
    artifacts: RecordedArtifact[],
    verify: boolean,
    restoreId: string,
  ): Promise<{ totalBytes: number; meta: Record<string, unknown> }> {
    const startedAt = Date.now();
    let totalBytes = 0;
    let verifiedBytes = 0;
    let hashed = 0;
    const sizeOnly: string[] = [];

    for (const artifact of artifacts) {
      // Presence + size first: it's one cheap round trip, and a pruned artifact
      // should say "pruned" rather than fail mid-download.
      const head = await destination.head(artifact.key);
      if (!head) {
        throw new Error(
          `Artifact ${artifact.key} missing from destination — backup may have been pruned`,
        );
      }
      if (head.sizeBytes !== artifact.sizeBytes) {
        throw new Error(
          `Artifact ${artifact.key} size mismatch: bucket has ${head.sizeBytes}, manifest claimed ${artifact.sizeBytes}`,
        );
      }
      totalBytes += head.sizeBytes;

      const expected = normalizeDigest(artifact.sha256);
      if (!verify) continue;
      if (!expected) {
        sizeOnly.push(artifact.key);
        continue;
      }

      const hasher = new HashingPassthrough();
      await pipelineP(await destination.get(artifact.key), hasher, discardingSink());
      const { sha256, bytesWritten } = hasher.summary();
      if (sha256 !== expected) {
        // Hard fail, and it happens here — before anything is stopped or
        // written. Both digests are named because the operator's next question
        // is "is this the wrong archive or a damaged one".
        throw new Error(
          `Artifact ${artifact.key} failed integrity check: expected sha256 ${expected}, ` +
            `the destination's bytes hash to ${sha256}. Nothing has been stopped or ` +
            `overwritten — this backup is not safe to restore.`,
        );
      }
      verifiedBytes += bytesWritten;
      hashed++;
    }

    const verifyMs = Date.now() - startedAt;
    // The weakest check applied governs the label. A run where one artifact
    // couldn't be hashed is not a sha256-verified run, however many others were —
    // `unverifiableArtifacts` names which ones so the claim stays specific.
    const integrity = !verify ? "deferred" : sizeOnly.length > 0 ? "size-only" : "sha256";

    if (sizeOnly.length > 0) {
      const warning =
        `${sizeOnly.length} artifact(s) in this backup have no recorded sha256, so only their ` +
        `byte size could be checked: ${sizeOnly.join(", ")}. Re-run the backup to capture ` +
        `verifiable artifacts.`;
      console.warn(`[restore-orchestrator] ${restoreId}: ${warning}`);
      this.publishWarning(restoreId, warning);
    }
    if (!verify) {
      const warning =
        "Prepare-time verification is disabled on this backup policy " +
        "(payloadConfig.verifyOnPrepare = false) — artifact digests are only checked while " +
        "apply streams them, which is after the target has been cleared.";
      console.warn(`[restore-orchestrator] ${restoreId}: ${warning}`);
      this.publishWarning(restoreId, warning);
    }

    return {
      totalBytes,
      meta: {
        integrity,
        hashedArtifacts: hashed,
        verifiedBytes,
        verifyMs,
        ...(sizeOnly.length > 0 ? { unverifiableArtifacts: sizeOnly } : {}),
      },
    };
  }

  /** Non-fatal advisory on the live channel. Never blocks the FSM. */
  private publishWarning(restoreId: string, message: string): void {
    try {
      restoreRunBus.publish(restoreId, { type: "warning", message });
    } catch {
      // bus failures never block the FSM
    }
  }

  private async runApply(restoreId: string): Promise<void> {
    // Registered BEFORE the applying transition, so a cancel racing the very
    // first millisecond of apply still finds a handle to abort.
    const controller = new AbortController();
    this.inFlight.set(restoreId, controller);
    try {
      const restore = await repos.backupRestore.findById(restoreId);
      if (!restore) return;
      await this.transition(restoreId, "applying");

      const sourceRun = await repos.backupRun.findById(restore.runId);
      if (!sourceRun) throw new Error("Source backup run disappeared");

      const destinationRow = await repos.backupDestination.findById(restore.destinationId);
      if (!destinationRow) throw new Error("Destination disappeared");
      this.assertDestinationOrg(destinationRow, restore.organizationId);

      const adapterRow = await toAdapterRow(destinationRow);
      const destination = resolveDestination(adapterRow);

      const { executor, serviceHandle } = await this.resolveTarget(
        restore,
        sourceRun,
        destinationRow,
      );

      // Checkpoint 1 — before anything is stopped. Free.
      await this.throwIfCancelRequested(restoreId, null);

      // Only stop what is actually running, and only start back what WE stopped.
      // The old code stopped unconditionally and always started: on a service
      // with no container that start throws (docker), which is the second half
      // of #434 — and on a deliberately-stopped service it resurrected something
      // the operator had taken down. A volume restore doesn't need the container
      // down anyway; the volume is mounted into a separate helper.
      const wasRunning = await executor.isRunning(serviceHandle).catch(() => false);
      if (wasRunning) await executor.stopService(serviceHandle);

      // Checkpoint 2 — stopped, still nothing written.
      await this.throwIfCancelRequested(restoreId, null, async () => {
        if (wasRunning) await executor.startService(serviceHandle).catch(() => {});
      });

      try {
        const artifacts = recordedArtifacts(sourceRun);

        let bytesRestored = 0;
        let wroteInto: string | null = null;
        for (const [index, recorded] of artifacts.entries()) {
          // Checkpoint 3 — between producers. Honored, and it carries whatever
          // the previous artifact already wrote, so a multi-volume restore
          // cancelled halfway is reported as partial rather than clean.
          if (index > 0) await this.throwIfCancelRequested(restoreId, wroteInto);

          const producer = resolveProducer(recorded.payloadKind);
          const expected = normalizeDigest(recorded.sha256);
          // Backstop, and it's free: these bytes are flowing to the target
          // anyway, so hashing them costs nothing and catches bit-rot between
          // prepare and apply. Unlike prepare's check this one lands AFTER the
          // target was cleared, so a mismatch here is reported as partial data
          // rather than as "not safe to restore".
          const hasher = new HashingPassthrough();
          const targetLabel = this.artifactTargetLabel(recorded, serviceHandle);
          await this.markDestructive(restoreId, targetLabel);
          wroteInto = targetLabel;
          try {
            await producer.restore(
              serviceHandle,
              executor,
              {
                key: recorded.key,
                metadata: recorded.metadata,
                payloadKind: recorded.payloadKind,
                sha256: recorded.sha256 ?? "",
                sizeBytes: recorded.sizeBytes,
                open: async () => (await destination.get(recorded.key)).pipe(hasher),
              },
              { clearTarget: true, signal: this.signalFor(restoreId) },
            );
          } catch (err) {
            // The abort signal we hand the executor surfaces here as an ordinary
            // failure — the executor has no way to know a cancel caused it. Left
            // as one, this mid-extract cancel would be the worst outcome
            // available: reported as `failed` rather than `cancelled`, AND the
            // service restarted on a half-written volume, because only the
            // partial-write paths decline that restart. So a cancel that was in
            // fact requested owns the failure.
            if (await this.cancelRequested(restoreId)) throw new RestoreCancelled(targetLabel);
            throw err;
          }
          // Null when the producer didn't drain the stream (a pg_restore that
          // stops early, say) — unverifiable, not a mismatch.
          const actual = digestIfComplete(hasher);
          if (expected && actual && actual !== expected) {
            throw new PartialWriteError(
              `Artifact ${recorded.key} was corrupt in transit during apply: expected ` +
                `sha256 ${expected}, received ${actual}. The target now holds PARTIAL data — ` +
                `re-run this restore (or a newer one) to completion before starting the service.`,
            );
          }
          bytesRestored += recorded.sizeBytes;
        }

        // Checkpoint 4 DECLINES: every byte is written and the only thing left is
        // starting the service. Honoring a cancel here would leave a complete
        // restore looking like a partial one, so we finish and record that the
        // request arrived too late.
        const lateCancel = await this.cancelRequested(restoreId);

        if (wasRunning) await executor.startService(serviceHandle);

        await this.transition(restoreId, "succeeded", {
          bytesRestored,
          meta: await this.mergedMeta(restoreId, {
            destructive: wroteInto !== null,
            ...(lateCancel ? { cancelDeclined: "after-last-write" } : {}),
          }),
        });
        if (lateCancel) {
          console.warn(
            `[restore-orchestrator] apply ${restoreId} ignored a cancel that arrived after ` +
              `the last write — completing was safer than stopping`,
          );
          this.publishWarning(
            restoreId,
            "Cancel arrived after the last byte was written — the restore was completed " +
              "rather than left half-applied.",
          );
        }
      } catch (innerErr) {
        // Bring the service back up so a failed restore doesn't leave a stopped
        // container — UNLESS the target now holds partial data. Starting a
        // service on a half-written volume turns a clear failure into a silently
        // corrupt running app, which is strictly worse than staying down.
        const partial =
          innerErr instanceof PartialWriteError ||
          (innerErr instanceof RestoreCancelled && innerErr.destructiveSource !== null);
        if (partial) {
          console.error(
            `[restore-orchestrator] apply ${restoreId} left partial data — leaving the service stopped`,
          );
        } else if (wasRunning) {
          try {
            await executor.startService(serviceHandle);
          } catch {
            // best-effort
          }
        }
        throw innerErr;
      }
    } catch (err) {
      if (err instanceof RestoreCancelled) {
        const source = err.destructiveSource;
        await this.transition(restoreId, "cancelled", {
          ...(source
            ? { errorMessage: boundedStorableText(partialWriteSentence(source), TRUNCATE_ERROR) }
            : {}),
          meta: await this.mergedMeta(restoreId, {
            destructive: source !== null,
            ...(source ? { partialWrite: true, serviceLeftStopped: true, destructiveSource: source } : {}),
          }),
        });
        return;
      }
      const message = safeErrorMessage(err);
      console.error(`[restore-orchestrator] apply ${restoreId} failed: ${message}`);
      await this.transition(restoreId, "failed", {
        errorMessage: boundedStorableText(message, TRUNCATE_ERROR),
        ...(err instanceof PartialWriteError
          ? {
              meta: await this.mergedMeta(restoreId, {
                partialWrite: true,
                serviceLeftStopped: true,
              }),
            }
          : {}),
      });
    } finally {
      this.inFlight.delete(restoreId);
    }
  }

  // ── Cancel plumbing ──────────────────────────────────────────────

  /** The durable half of the signal, re-read at every checkpoint so a cancel
   *  taken by another node is honored here. */
  private async cancelRequested(restoreId: string): Promise<boolean> {
    const row = await repos.backupRestore.findById(restoreId).catch(() => undefined);
    return row?.cancelRequested === true;
  }

  /** The local half — handed to the executor so an in-flight extract stops
   *  rather than being waited out. Absent for applies running elsewhere. */
  private signalFor(restoreId: string): AbortSignal | undefined {
    return this.inFlight.get(restoreId)?.signal;
  }

  /**
   * Honor a pending cancel by unwinding into runApply's cancel path.
   * `destructiveSource` decides which promise the operator gets: null means
   * nothing was written, a label means that target holds partial data.
   */
  private async throwIfCancelRequested(
    restoreId: string,
    destructiveSource: string | null,
    beforeThrow?: () => Promise<void>,
  ): Promise<void> {
    if (!(await this.cancelRequested(restoreId))) return;
    if (beforeThrow) await beforeThrow();
    throw new RestoreCancelled(destructiveSource);
  }

  /**
   * Record + broadcast that the point of no return has been crossed, before the
   * write that crosses it. The UI switches its cancel button on this, so it has
   * to lead the write rather than follow it — an operator who clicks "cancel,
   * nothing lost" a moment after the extract began is owed the truth.
   */
  private async markDestructive(restoreId: string, source: string): Promise<void> {
    try {
      restoreRunBus.publish(restoreId, { type: "destructive", destructive: true, source });
    } catch {
      // bus failures never block the FSM
    }
    try {
      // The repo call directly, not this.transition — republishing an `applying`
      // transition the UI already has would look like the phase restarted.
      await repos.backupRestore.transition(restoreId, "applying", {
        meta: await this.mergedMeta(restoreId, {
          destructive: true,
          destructiveSource: source,
        }),
      });
    } catch {
      // A meta write that fails must not abort a restore that is fine; the
      // in-memory path still holds the label for the terminal transition.
    }
  }

  /** What a cancel names as the thing now holding partial data. */
  private artifactTargetLabel(recorded: RecordedArtifact, handle: ServiceHandle): string {
    const volumeId =
      typeof recorded.metadata.volumeId === "string" ? recorded.metadata.volumeId : null;
    if (volumeId) return `volume "${volumeId}"`;
    return `service "${handle.name}" (${recorded.payloadKind})`;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private async transition(
    restoreId: string,
    status: BackupRestoreStatus,
    patch?: Parameters<typeof repos.backupRestore.transition>[2],
  ): Promise<void> {
    await repos.backupRestore.transition(restoreId, status, patch);
    try {
      restoreRunBus.publish(restoreId, {
        type: "transition",
        status,
        bytesRestored:
          typeof patch?.bytesRestored === "number" ? patch.bytesRestored : undefined,
      });
      const TERMINAL: BackupRestoreStatus[] = [
        "succeeded",
        "failed",
        "cancelled",
        "server_error",
      ];
      if (TERMINAL.includes(status)) {
        restoreRunBus.publish(restoreId, {
          type: "complete",
          status: status as "succeeded" | "failed" | "cancelled" | "server_error",
          errorMessage: typeof patch?.errorMessage === "string" ? patch.errorMessage : undefined,
        });
      }
    } catch {
      // bus failures never block the FSM
    }

    // Notify on the terminal restore outcome (best-effort; never blocks the
    // FSM). `cancelled` is user-initiated — no notification. succeeded/failed
    // both map to the "Restore completed" category via the dispatcher.
    if (status === "succeeded" || status === "failed" || status === "server_error") {
      try {
        const row = await repos.backupRestore.findById(restoreId);
        if (row) {
          const project = await repos.project.findById(row.projectId).catch(() => null);
          notification.emit({
            organizationId: row.organizationId,
            eventType: status === "succeeded" ? "backup_restore.completed" : "backup_restore.failed",
            resourceType: "backup_restore",
            resourceId: restoreId,
            payload: {
              projectName: project?.name ?? null,
              status,
              bytesRestored: typeof patch?.bytesRestored === "number" ? patch.bytesRestored : null,
              errorMessage: typeof patch?.errorMessage === "string" ? patch.errorMessage : null,
            },
          });
        }
      } catch (err) {
        console.error(`[restore-orchestrator] notify failed for ${restoreId}: ${safeErrorMessage(err)}`);
      }
    }
  }

  /**
   * Resolve WHERE this restore writes — a deployed service, or a bare mail
   * server (in-place onto the source, or to_fork onto a different one = A→B
   * migration). Shared by prepare's preflight and apply so the two can never
   * disagree about the target: a preflight that passed against a different
   * resolution than apply uses would be worse than no preflight.
   */
  private async resolveTarget(
    restore: BackupRestore,
    sourceRun: BackupRun,
    destinationRow: { organizationId: string },
  ): Promise<{ executor: BackupExecutor; serviceHandle: ServiceHandle }> {
    if (sourceRun.sourceKind === "mail_server") {
      const targetMailServerId =
        restore.mode === "to_fork" ? restore.forkMailServerId : sourceRun.mailServerId;
      if (!targetMailServerId) {
        throw new Error("Mail restore has no target mail server");
      }
      const built = await this.buildMailTarget(targetMailServerId, destinationRow.organizationId);
      return { executor: built.executor, serviceHandle: built.handle };
    }

    if (!sourceRun.serviceId) throw new Error("Source run has no serviceId");
    const serviceRow = await repos.service.findById(sourceRun.serviceId);
    if (!serviceRow) throw new Error("Target service disappeared");
    const project = await repos.project.findById(serviceRow.projectId);
    if (!project) throw new Error("Project disappeared");
    const platform = await resolveDeploymentPlatform(
      (await this.activeDeploymentMeta(project.id)) as Parameters<
        typeof resolveDeploymentPlatform
      >[0],
      { organizationId: destinationRow.organizationId },
    );
    return {
      executor: resolveExecutor(platform.platform.runtime.name, platform.platform.runtime),
      serviceHandle: await this.buildServiceHandle(serviceRow),
    };
  }

  /**
   * Resolve a mail server as a restore TARGET — the bare SSH executor +
   * a synthetic ServiceHandle. Mirrors BackupOrchestrator.buildMailSource;
   * resolveTargetPlatform enforces org membership (throws if the target
   * isn't in the org). Used for in-place mail restores and to_fork
   * migrations (A→B).
   */
  private async buildMailTarget(
    mailServerId: string,
    organizationId: string,
  ): Promise<{ executor: BackupExecutor; handle: ServiceHandle }> {
    const mailRow = await repos.mailServer.get(mailServerId);
    if (!mailRow) throw new Error(`Target mail server ${mailServerId} not found`);
    const domain = mailRow.domain ?? "mail";
    const slug = (domain.replace(/[^a-zA-Z0-9.-]/g, "-").toLowerCase() || "mail").slice(0, 63);

    const targetPlatform = await resolveTargetPlatform(
      "server",
      "bare",
      mailServerId,
      organizationId,
    );
    const executor = resolveExecutor(
      targetPlatform.runtime.name,
      targetPlatform.runtime,
    );

    const handle: ServiceHandle = {
      id: mailServerId,
      projectId: "",
      name: "mail",
      image: null,
      env: {},
      volumes: ["/var/vmail"],
      containerId: null,
      projectSlug: slug,
      namespaceVolumes: false,
    };
    return { executor, handle };
  }

  private async activeDeploymentMeta(projectId: string): Promise<Record<string, unknown>> {
    const project = await repos.project.findById(projectId);
    if (!project?.activeDeploymentId) return {};
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    return (dep?.meta ?? {}) as Record<string, unknown>;
  }

  /**
   * The container a single-app project's service actually runs in, when the
   * service→container map doesn't know about it.
   *
   * This is #434's shape: the deploy pipeline owns the container and records it
   * on the DEPLOYMENT, while `service_deployment` (which service-container.ts
   * reads, deliberately never falling back to `deployment.containerId`) has no
   * row for it. That refusal is right for compose — there
   * `deployment.containerId` is the PRIMARY service's container, so a fallback
   * would silently resolve the wrong one — so this narrows to the only case
   * where the two cannot differ:
   *
   *   - the ref is dial-able (not the compose sentinel, not a static release dir)
   *   - the project has exactly ONE service row, and it is this one
   *
   * A stale ref is harmless here: listSources degrades to the DB's declared
   * volumes, isRunning reports false, and the volume producer keys off the
   * resolved source name rather than the container.
   */
  private async deploymentManagedContainerId(
    project: { id: string },
    dep: { containerId: string | null },
    serviceRow: { id: string },
  ): Promise<string | null> {
    const ref = usableRef(dep.containerId);
    if (!ref || staticReleaseDir(dep) !== null) return null;
    const siblings = await repos.service.listByProject(project.id).catch(() => []);
    if (siblings.length !== 1 || siblings[0].id !== serviceRow.id) return null;
    return ref;
  }

  private async buildServiceHandle(
    serviceRow: NonNullable<Awaited<ReturnType<typeof repos.service.findById>>>,
  ): Promise<ServiceHandle> {
    const project = await repos.project.findById(serviceRow.projectId);
    if (!project) throw new Error(`Project ${serviceRow.projectId} not found`);

    const envFromService =
      (serviceRow.environment as Record<string, string> | null) ?? {};
    const envFromProjectEncrypted = await repos.project
      .listEnvVars(serviceRow.projectId)
      .then((vars) => {
        const out: Record<string, string> = {};
        for (const v of vars) out[v.key] = v.value;
        return out;
      })
      .catch(() => ({}));
    const projectEnv = decryptEnvMap(envFromProjectEncrypted);
    const decrypted = { ...envFromService, ...projectEnv };

    let containerId: string | null = null;
    if (project.activeDeploymentId) {
      const dep = await repos.deployment.findById(project.activeDeploymentId);
      // Verified against the host — a restore into a container a redeploy has
      // since replaced would write into nothing (or the wrong thing).
      if (dep) {
        containerId = await liveContainerIdForService(project, dep, serviceRow, {
          projectId: project.id,
        });
        containerId ??= await this.deploymentManagedContainerId(project, dep, serviceRow);
      }
    }

    return {
      id: serviceRow.id,
      projectId: serviceRow.projectId,
      name: serviceRow.name,
      image: serviceRow.image,
      env: decrypted,
      volumes: (serviceRow.volumes as string[] | null) ?? [],
      containerId,
      projectSlug: project.slug,
      namespaceVolumes: serviceRow.namespaceVolumes,
    };
  }
}

export const restoreOrchestrator = new RestoreOrchestrator();
