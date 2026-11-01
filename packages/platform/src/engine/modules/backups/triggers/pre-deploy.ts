/**
 * Enqueue each enabled policy and await ALL fan-out children before deployment.
 * A cached build must not start migrations while a dump holds database locks.
 * Called once in kickoffBuild, BEFORE workspace admission: backup workers need
 * that same workspace lock, so waiting inside it would deadlock managed deploys.
 */
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { setTimeout as delay } from "node:timers/promises";
import { repos, type BackupPolicy } from "@repo/db";
import {
  formatBytes,
  formatDuration,
  safeErrorMessage,
  type LogEntry,
  type PromptPayload,
} from "@repo/core";
import { backupOrchestrator } from "../backup.orchestrator";
import { BACKUP_RUN_CEILING_STALE_MS } from "../backup-stale-sweep";
import {
  raceDeploymentCancellation,
  throwIfDeploymentCancelled,
} from "../../deployments/deployment-cancellation";

const POLL_MS = 1_000;
const PROGRESS_MS = 30_000;

export type PreDeployBackupPolicy = Pick<BackupPolicy, "id" | "createdBy">;

interface BackupTarget {
  policyId: string;
  userId: string;
  serviceId?: string;
}

export async function firePreDeployBackups(opts: {
  projectId: string;
  organizationId: string;
  /** Cloud queue admission captures the required set before taking its resource
   * reservation. Later policy edits apply to subsequent admissions. */
  policies?: readonly PreDeployBackupPolicy[];
  signal?: AbortSignal;
  log?: (message: string, level?: LogEntry["level"]) => void;
  promptUser?: (prompt: PromptPayload) => Promise<string>;
}): Promise<{ enqueued: number; completed: number }> {
  throwIfDeploymentCancelled(opts.signal);
  const startedAt = Date.now();
  // Failure to read policies is not evidence that backups are disabled.
  const policies = opts.policies ?? await repos.backupPolicy.listEnabledPreDeployByProject(opts.projectId);
  if (policies.length === 0) return { enqueued: 0, completed: 0 };
  // Names are only presentation; an unavailable name must not bypass the gate.
  const services = await repos.service.listByProject(opts.projectId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/backups/triggers/pre-deploy"); return []; });
  const names = new Map(services.map((service) => [service.id, service.name]));
  const log = (message: string, level?: LogEntry["level"]) => {
    const line = `[pre-deploy-backup] ${message}`;
    if (level) opts.log?.(line, level);
    else opts.log?.(line);
  };
  const elapsed = () => formatDuration(Math.floor((Date.now() - startedAt) / 1_000));
  let targets: BackupTarget[] = policies.map((policy) => ({
    policyId: policy.id,
    userId: policy.createdBy ?? "system",
  }));
  let enqueued = 0;
  let completed = 0;

  while (targets.length > 0) {
    const deadline = Date.now() + BACKUP_RUN_CEILING_STALE_MS;
    const pending = new Map<string, BackupTarget>();
    const failures: Array<{ target: BackupTarget; message: string }> = [];

    for (const target of targets) {
      throwIfDeploymentCancelled(opts.signal);
      log(
        `Queueing policy ${target.policyId}${target.serviceId ? ` for ${names.get(target.serviceId) ?? target.serviceId}` : ""}.`,
      );
      const queueProgress = setInterval(() => {
        log(
          `Still queueing policy ${target.policyId}; ${elapsed()} elapsed. The new release has not started.`,
        );
      }, PROGRESS_MS);
      try {
        const { runIds } = await raceDeploymentCancellation(
          backupOrchestrator.enqueue({
            policyId: target.policyId,
            serviceId: target.serviceId,
            trigger: { source: "pre_deploy", userId: target.userId },
          }),
          opts.signal,
        );
        if (runIds.length === 0) throw new Error("no backup runs were created");
        for (const id of runIds) pending.set(id, target);
      } catch (error) {
        observeCaughtError(error, "platform/engine/modules/backups/triggers/pre-deploy");
        throwIfDeploymentCancelled(opts.signal);
        const message = `policy ${target.policyId}: ${safeErrorMessage(error)}`;
        failures.push({ target, message });
        log(`Could not start ${message}`, "warn");
      } finally {
        clearInterval(queueProgress);
      }
    }
    throwIfDeploymentCancelled(opts.signal);
    if (failures.length && !opts.promptUser) {
      throw new Error(
        `Pre-deploy backup could not start: ${failures.map((f) => f.message).join("; ")}`,
      );
    }

    enqueued += pending.size;
    if (pending.size)
      log(`Waiting for ${pending.size} backup run(s) before building or starting the new release.`);
    const statuses = new Map<string, string>();
    let lastProgressAt = Date.now();

    while (pending.size > 0) {
      throwIfDeploymentCancelled(opts.signal);
      if (Date.now() >= deadline) {
        // A timeout does not prove pg_dump released its locks. Never offer a
        // bypass while a worker can still be running (including stale sweeps).
        throw new Error(
          `Pre-deploy backup timed out waiting for ${[...pending.keys()].join(", ")}; deployment stopped.`,
        );
      }
      const progressDue = Date.now() - lastProgressAt >= PROGRESS_MS;
      for (const [id, target] of pending) {
        const run = await repos.backupRun.findById(id);
        throwIfDeploymentCancelled(opts.signal);
        if (!run || run.deletedAt)
          throw new Error(`Pre-deploy backup ${id} disappeared; deployment stopped.`);
        const label =
          run.serviceId && names.has(run.serviceId) ? `${names.get(run.serviceId)} (${id})` : id;
        const failed = ["failed", "cancelled", "server_error"].includes(run.status);
        const failure = `${label} ${run.status}: ${run.errorMessage || "backup did not complete"}`;
        if (failed && !opts.promptUser) throw new Error(`Pre-deploy backup ${failure}`);

        // Terminal status precedes the worker's finally. An unclaimed terminal
        // run is safe too: claimExecution can only claim a queued row.
        const cleanedUp = !!run.executionFinishedAt || (failed && !run.executionStartedAt);
        if (failed && cleanedUp) {
          pending.delete(id);
          failures.push({
            target: { ...target, serviceId: run.serviceId ?? target.serviceId },
            message: failure,
          });
          log(`${label} ${run.status}: ${run.errorMessage || "backup did not complete"}`, "warn");
        } else if (run.status === "succeeded" && cleanedUp) {
          pending.delete(id);
          completed += 1;
          log(`${label} succeeded; ${elapsed()} elapsed.`);
        } else {
          const status = failed
            ? `${run.status}: ${run.errorMessage || "backup did not complete"}; finishing cleanup`
            : run.status === "succeeded"
              ? "finishing cleanup"
              : run.status;
          if (statuses.get(id) !== status || progressDue) {
            statuses.set(id, status);
            const bytes =
              run.bytesTransferred == null ? "" : `; ${formatBytes(run.bytesTransferred)} uploaded`;
            log(`${label}: ${status}; ${elapsed()} elapsed${bytes}.`, failed ? "warn" : undefined);
          }
        }
      }
      if (pending.size === 0) break;
      if (progressDue) {
        log(
          `Still waiting for ${pending.size} backup run(s); the new release has not started. You can stop this deployment while backups finish.`,
        );
        lastProgressAt = Date.now();
      }
      try {
        await delay(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), undefined, {
          signal: opts.signal,
        });
      } catch (error) {
        throwIfDeploymentCancelled(opts.signal);
        throw error;
      }
    }

    if (failures.length === 0) break;
    // No worker in this attempt can still hold database locks. Only now can an
    // explicit bypass be safe. Retry just the failed sources, retaining successes.
    const promptId = `pre_deploy_backup:${crypto.randomUUID()}`;
    const retry = `${promptId}:retry`;
    const skip = `${promptId}:skip`;
    const stop = `${promptId}:stop`;
    log(`Deployment paused after ${elapsed()}. Waiting for a backup decision.`, "warn");
    let action: string;
    try {
      action = await raceDeploymentCancellation(
        opts.promptUser!({
          promptId,
          title: "Pre-deploy backup failed",
          message:
            "The new release has not started. Retry the failed backups, continue without them, or stop this deployment. Continuing may leave you unable to restore data changed by this release.",
          actions: [
            { id: retry, label: "Retry backup", variant: "primary" },
            { id: skip, label: "Continue without backup", variant: "danger" },
            { id: stop, label: "Stop deployment", variant: "secondary" },
          ],
          details: { backupErrors: failures.map((failure) => failure.message) },
        }),
        opts.signal,
      );
      throwIfDeploymentCancelled(opts.signal);
    } catch (error) {
      observeCaughtError(error, "platform/engine/modules/backups/triggers/pre-deploy");
      throwIfDeploymentCancelled(opts.signal);
      log(`No backup decision received; deployment stopped: ${safeErrorMessage(error)}`, "warn");
      throw new Error(`Pre-deploy backup decision failed: ${safeErrorMessage(error)}`);
    }
    if (action === skip) {
      log(
        "User chose Continue without backup for this deployment. Failed backups are not restore points; the backup policies remain enabled.",
        "warn",
      );
      return { enqueued, completed };
    }
    if (action !== retry) {
      log(
        action === stop
          ? "User stopped the deployment after a backup failure."
          : "Invalid backup decision; deployment stopped.",
        "warn",
      );
      throw new Error(
        `Pre-deploy backup ${action === stop ? "failed; deployment stopped by user" : "decision was invalid; deployment stopped"}.`,
      );
    }
    log("User chose Retry backup. Retrying failed backups before starting the new release.");
    targets = [
      ...new Map(
        failures.map(({ target }) => [`${target.policyId}:${target.serviceId ?? "*"}`, target]),
      ).values(),
    ];
  }
  log("All required backups succeeded. Deployment can continue.");
  return { enqueued, completed };
}
