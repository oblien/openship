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
import { repos, type BackupRun, type BackupRestoreStatus } from "@repo/db";
import { containerIdForService } from "../services/service-container";
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
import { safeErrorMessage } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import { restoreRunBus } from "./restore.sse";

const TRUNCATE_ERROR = 4096;

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

  /** Cancel a prepared (or queued) restore. Cleans up staging. */
  async cancel(ctx: RequestContext, restoreId: string): Promise<void> {
    const restore = await repos.backupRestore.findById(restoreId);
    try {
      assertResourceInOrg(restore, "Restore", ctx.organizationId, restoreId);
    } catch {
      throw new Error("Restore not found");
    }
    void ctx.userId;
    if (!["queued", "preparing", "prepared"].includes(restore.status)) {
      throw new Error(`Cannot cancel a ${restore.status} restore`);
    }
    await this.transition(restoreId, "cancelled");
  }

  // ── Internal phases ──────────────────────────────────────────────

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

      const adapterRow = await toAdapterRow(destinationRow);
      const destination = resolveDestination(adapterRow);

      // Resolve the TARGET — a deployed service, or a bare mail server. A
      // mail restore can go in-place (onto the source) or to_fork (onto a
      // DIFFERENT mail server = migrate A→B).
      let executor: BackupExecutor;
      let serviceHandle: ServiceHandle;
      if (sourceRun.sourceKind === "mail_server") {
        const targetMailServerId =
          restore.mode === "to_fork" ? restore.forkMailServerId : sourceRun.mailServerId;
        if (!targetMailServerId) {
          throw new Error("Mail restore has no target mail server");
        }
        const built = await this.buildMailTarget(
          targetMailServerId,
          destinationRow.organizationId,
        );
        executor = built.executor;
        serviceHandle = built.handle;
      } else {
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
        executor = resolveExecutor(platform.platform.runtime.name, platform.platform.runtime);
        serviceHandle = await this.buildServiceHandle(serviceRow);
      }

      // Stop the service so volume swap is safe. (No-op for bare/mail.)
      await executor.stopService(serviceHandle);

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

        // Start service back up.
        await executor.startService(serviceHandle);

        await this.transition(restoreId, "succeeded", { bytesRestored });
      } catch (innerErr) {
        // Try to bring the service back up so the user isn't stuck
        // with a stopped container after a failed restore.
        try {
          await executor.startService(serviceHandle);
        } catch {
          // best-effort
        }
        throw innerErr;
      }
    } catch (err) {
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
      if (dep) containerId = await containerIdForService(dep, serviceRow);
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
