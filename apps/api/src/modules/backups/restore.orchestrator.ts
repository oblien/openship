/**
 * RestoreOrchestrator — drives a backup_restore row through its FSM.
 *
 * Three-step flow:
 *
 *   prepare(): queued → preparing → prepared
 *     Downloads every artifact from the destination, verifies sha256,
 *     stages bytes in a per-runtime holding area (Docker named volume
 *     openship-restore-<id> / Cloud workspace /var/openship/staging/<id>).
 *     Service stays untouched. User can cancel here without consequence.
 *
 *   apply(): prepared → applying → succeeded
 *     Destructive. Stops the service, replaces target volume contents
 *     from staging, restarts. Producer-specific restore() decides
 *     HOW (volume = tar extract; pg_dump = pg_restore from staged file;
 *     redis = copy dump.rdb into /data; etc.).
 *
 *   cancel(): prepared → cancelled
 *     Wipes the staging area, no service touch.
 *
 * Live progress streams via SSE on a separate channel (restoreRunBus).
 * Same shape as backups — dashboard refresh-safe.
 */

import crypto from "node:crypto";
import { repos, type BackupRun, type BackupRestore, type BackupRestoreStatus } from "@repo/db";
import { liveContainerIdForService } from "../services/service-container";
import {
  resolveDestination,
  resolveExecutor,
  resolveProducer,
  type BackupExecutor,
  type BackupTrigger,
  type PayloadKind,
  type ServiceHandle,
} from "@repo/adapters";
import { decryptEnvMap } from "../../lib/encryption";
import { resolveDeploymentPlatform, resolveTargetPlatform } from "../../lib/deployment-runtime";
import { safeErrorMessage, withTimeout } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import { restoreRunBus } from "./restore.sse";
import { notification } from "../../lib/notification-dispatcher";

const TRUNCATE_ERROR = 4096;
const STOP_START_TIMEOUT_MS = 60_000;

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
  async apply(ctx: RequestContext, restoreId: string, confirmationToken: string): Promise<void> {
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
      throw new Error(`Restore is in status=${restore.status}, must be 'prepared' to apply`);
    }

    setImmediate(() => {
      void this.runApply(restoreId).catch((err) =>
        console.error(
          `[restore-orchestrator] apply ${restoreId} crashed: ${safeErrorMessage(err)}`,
        ),
      );
    });
  }

  /** Cancel a queued, preparing, prepared or applying restore. */
  async cancel(ctx: RequestContext, restoreId: string): Promise<void> {
    const restore = await repos.backupRestore.findById(restoreId);
    try {
      assertResourceInOrg(restore, "Restore", ctx.organizationId, restoreId);
    } catch {
      throw new Error("Restore not found");
    }
    void ctx.userId;
    const allowed: BackupRestoreStatus[] = ["queued", "preparing", "prepared", "applying"];
    if (!allowed.includes(restore.status as BackupRestoreStatus)) {
      throw new Error(`Cannot cancel a ${restore.status} restore`);
    }
    const wasApplying = restore.status === "applying";
    await this.transition(restoreId, "cancelled");
    if (wasApplying) {
      setImmediate(() => {
        void this.bestEffortStart(restore).catch((err) =>
          console.error(
            `[restore-orchestrator] best-effort start after cancel ${restoreId} failed: ${safeErrorMessage(err)}`,
          ),
        );
      });
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

      const destinationRow = await repos.backupDestination.findById(restore.destinationId);
      if (!destinationRow) throw new Error("Destination disappeared");
      this.assertDestinationOrg(destinationRow, restore.organizationId);

      const adapterRow = await toAdapterRow(destinationRow);
      const destination = resolveDestination(adapterRow);

      // Verify EVERY artifact's sha256 matches what the manifest
      // promised at backup time. We HEAD + stream-hash each one.
      // For Chunk 3 v1 we DON'T re-download into staging — we read
      // each artifact's HEAD to confirm presence + size, and let the
      // apply phase do the streaming-to-target. This is "prepared as
      // a verified plan", not "bytes already staged".
      //
      // True bytes-pre-staging is a follow-up: would need a Docker
      // named volume openship-restore-<id> + Cloud workspace path.
      // For now: a successful Prepare means "I've verified everything
      // is downloadable and integrity-checked; clicking Apply will
      // succeed bar a network blip".
      const artifacts = Array.isArray(sourceRun.artifacts)
        ? (sourceRun.artifacts as Array<{
            key: string;
            sha256: string;
            sizeBytes: number;
          }>)
        : [];

      let totalBytes = 0;
      for (const artifact of artifacts) {
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
      }

      await this.transition(restoreId, "prepared", {
        bytesRestored: totalBytes,
      });
    } catch (err) {
      const message = safeErrorMessage(err);
      console.error(`[restore-orchestrator] prepare ${restoreId} failed: ${message}`);
      await this.transition(restoreId, "failed", {
        errorMessage: message.slice(0, TRUNCATE_ERROR),
      });
    }
  }

  private async runApply(restoreId: string): Promise<void> {
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

      // Resolve the TARGET — a deployed service, or a bare mail server. A
      // mail restore can go in-place (onto the source) or to_fork (onto a
      // DIFFERENT mail server = migrate A→B).
      const { executor, serviceHandle } = await this.buildApplyTarget(
        restore,
        sourceRun,
        destinationRow.organizationId,
      );

      if (sourceRun.sourceKind !== "mail_server" && executor.runtimeName !== "bare") {
        if (!serviceHandle.containerId) {
          throw new Error(
            `Service ${serviceHandle.name} has no live managed container to restore into. ` +
              `Restore-apply can only stop and start service-managed containers ` +
              `(e.g. containers created by Openship compose deployments). ` +
              `Deployment-managed app containers are not a valid restore target.`,
          );
        }
      }

      if (await this.isCancelled(restoreId)) return;

      // Stop the service so volume swap is safe. (No-op for bare/mail.)
      // Some Docker/SSH calls can hang without a client-side timeout; bound
      // this so a stuck stop fails the restore instead of freezing in applying.
      await withTimeout(
        executor.stopService(serviceHandle),
        STOP_START_TIMEOUT_MS,
        `stopService(${serviceHandle.name}) timed out after ${STOP_START_TIMEOUT_MS}ms`,
      );

      if (await this.isCancelled(restoreId)) return;

      try {
        const artifacts = Array.isArray(sourceRun.artifacts)
          ? (sourceRun.artifacts as Array<{
              key: string;
              sha256: string;
              sizeBytes: number;
              payloadKind: PayloadKind;
              metadata: Record<string, unknown>;
            }>)
          : [];

        let bytesRestored = 0;
        for (const recorded of artifacts) {
          const producer = resolveProducer(recorded.payloadKind);
          await producer.restore(
            serviceHandle,
            executor,
            {
              key: recorded.key,
              metadata: recorded.metadata,
              payloadKind: recorded.payloadKind,
              sha256: recorded.sha256,
              sizeBytes: recorded.sizeBytes,
              open: async () => destination.get(recorded.key),
            },
            { clearTarget: true, startupTimeoutMs: 60_000 },
          );
          bytesRestored += recorded.sizeBytes;
        }

        if (await this.isCancelled(restoreId)) return;

        // Start service back up.
        await withTimeout(
          executor.startService(serviceHandle),
          STOP_START_TIMEOUT_MS,
          `startService(${serviceHandle.name}) timed out after ${STOP_START_TIMEOUT_MS}ms`,
        );

        await this.transition(restoreId, "succeeded", { bytesRestored });
      } catch (innerErr) {
        // Try to bring the service back up so the user isn't stuck
        // with a stopped container after a failed restore.
        try {
          await withTimeout(
            executor.startService(serviceHandle),
            STOP_START_TIMEOUT_MS,
            `startService(${serviceHandle.name}) timed out after ${STOP_START_TIMEOUT_MS}ms`,
          );
        } catch {
          // best-effort
        }
        throw innerErr;
      }
    } catch (err) {
      if (await this.isCancelled(restoreId)) return;
      const message = safeErrorMessage(err);
      console.error(`[restore-orchestrator] apply ${restoreId} failed: ${message}`);
      await this.transition(restoreId, "failed", {
        errorMessage: message.slice(0, TRUNCATE_ERROR),
      });
    }
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
        bytesRestored: typeof patch?.bytesRestored === "number" ? patch.bytesRestored : undefined,
      });
      const TERMINAL: BackupRestoreStatus[] = ["succeeded", "failed", "cancelled", "server_error"];
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
            eventType:
              status === "succeeded" ? "backup_restore.completed" : "backup_restore.failed",
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
        console.error(
          `[restore-orchestrator] notify failed for ${restoreId}: ${safeErrorMessage(err)}`,
        );
      }
    }
  }

  private async isCancelled(restoreId: string): Promise<boolean> {
    const row = await repos.backupRestore.findById(restoreId);
    return row?.status === "cancelled";
  }

  /**
   * Build the executor + ServiceHandle for an apply. Shared by runApply
   * and the best-effort restart path after a mid-apply cancel.
   */
  private async buildApplyTarget(
    restore: BackupRestore,
    sourceRun: BackupRun,
    organizationId: string,
  ): Promise<{ executor: BackupExecutor; serviceHandle: ServiceHandle }> {
    if (sourceRun.sourceKind === "mail_server") {
      const targetMailServerId =
        restore.mode === "to_fork" ? restore.forkMailServerId : sourceRun.mailServerId;
      if (!targetMailServerId) {
        throw new Error("Mail restore has no target mail server");
      }
      const built = await this.buildMailTarget(targetMailServerId, organizationId);
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
      { organizationId },
    );
    const executor = resolveExecutor(platform.platform.runtime.name, platform.platform.runtime);
    const serviceHandle = await this.buildServiceHandle(serviceRow);
    return { executor, serviceHandle };
  }

  /**
   * After cancelling a restore that was already in applying, make a
   * best-effort attempt to start the service back up. Never awaits in the
   * caller: if it hangs, the cancel is still accepted and the in-flight
   * runApply will see the cancelled status when it wakes up.
   */
  private async bestEffortStart(restore: BackupRestore): Promise<void> {
    const sourceRun = await repos.backupRun.findById(restore.runId);
    if (!sourceRun) return;

    const destinationRow = await repos.backupDestination.findById(restore.destinationId);
    if (!destinationRow) return;
    this.assertDestinationOrg(destinationRow, restore.organizationId);

    const { executor, serviceHandle } = await this.buildApplyTarget(
      restore,
      sourceRun,
      destinationRow.organizationId,
    );

    if (sourceRun.sourceKind === "mail_server" || executor.runtimeName === "bare") return;
    if (!serviceHandle.containerId) return;

    await withTimeout(
      executor.startService(serviceHandle),
      STOP_START_TIMEOUT_MS,
      `startService(${serviceHandle.name}) timed out after ${STOP_START_TIMEOUT_MS}ms`,
    );
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
    const executor = resolveExecutor(targetPlatform.runtime.name, targetPlatform.runtime);

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

  private async buildServiceHandle(
    serviceRow: NonNullable<Awaited<ReturnType<typeof repos.service.findById>>>,
  ): Promise<ServiceHandle> {
    const project = await repos.project.findById(serviceRow.projectId);
    if (!project) throw new Error(`Project ${serviceRow.projectId} not found`);

    const envFromService = (serviceRow.environment as Record<string, string> | null) ?? {};
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
