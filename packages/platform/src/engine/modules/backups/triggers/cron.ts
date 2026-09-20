/**
 * Cron trigger — turns `backup_policy.cron_expression` into a
 * recurring job on whichever JobRunner is live.
 *
 * Three responsibilities:
 *   1. Validate cron expressions at policy-write time (used by
 *      backup.service.ts on create/update).
 *   2. Translate one policy → one recurring runner job. Idempotent
 *      via `runner.scheduleRecurring()`: registering an existing jobId
 *      replaces in-place, so cron edits take effect immediately.
 *   3. Reconcile all enabled policies at boot.
 */

import cronParser from "cron-parser";
import { repos } from "@repo/db";
import { getJobRunner } from "@repo/platform/engine/lib/job-runner/index";
import { safeErrorMessage } from "@repo/core";
import { backupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { nativeJobsEnabled } from "../../../native/execution-policy";

export interface CronValidationResult {
  valid: boolean;
  reason?: string;
  nextRunAt?: Date;
}

export function validateCronExpression(expr: string): CronValidationResult {
  try {
    const interval = cronParser.parseExpression(expr);
    return {
      valid: true,
      nextRunAt: interval.next().toDate(),
    };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : "Invalid cron expression",
    };
  }
}

/** Stable jobId for a policy's recurring schedule. */
function scheduleJobId(policyId: string): string {
  return `policy:${policyId}`;
}

/**
 * Add or refresh the recurring job for one policy. The onTick callback
 * fires orchestrator.enqueue with source=cron, so cron-fired runs flow
 * through the same run pipeline as manual ones.
 */
export async function syncPolicySchedule(policyId: string): Promise<void> {
  if (!nativeJobsEnabled()) return;
  const policy = await repos.backupPolicy.findById(policyId);
  const runner = await getJobRunner();

  if (!policy || !policy.enabled || !policy.cronExpression) {
    await runner.removeRecurring(scheduleJobId(policyId));
    return;
  }

  if (!validateCronExpression(policy.cronExpression).valid) {
    console.warn(
      `[cron-trigger] policy ${policyId} has invalid cron "${policy.cronExpression}" — schedule disabled`,
    );
    await runner.removeRecurring(scheduleJobId(policyId));
    return;
  }

  await runner.scheduleRecurring({
    jobId: scheduleJobId(policyId),
    cronExpression: policy.cronExpression,
    onTick: async () => {
      // Re-read the policy at fire time so disable/destination edits
      // between schedule + tick are honored.
      const fresh = await repos.backupPolicy.findById(policyId);
      if (!fresh || !fresh.enabled) return;
      await backupOrchestrator.enqueue({
        policyId,
        trigger: {
          source: "cron",
          userId: fresh.createdBy ?? "system",
        },
      });
    },
  });
}

export async function removePolicySchedule(policyId: string): Promise<void> {
  if (!nativeJobsEnabled()) return;
  const runner = await getJobRunner();
  await runner.removeRecurring(scheduleJobId(policyId));
}

/**
 * Boot-time reconciliation. Walks every enabled policy with a cron
 * expression and ensures its recurring job is registered with the
 * runner.
 *
 * Streams the policy list in pages so that an instance with thousands
 * of policies doesn't block boot — schedules register incrementally
 * and small orgs aren't held hostage by large ones.
 */
export async function reconcileAllSchedules(): Promise<{
  registered: number;
  skipped: number;
}> {
  let registered = 0;
  let skipped = 0;
  for await (const row of repos.backupPolicy.iterateEnabledScheduled(100)) {
    try {
      await syncPolicySchedule(row.id);
      registered += 1;
    } catch (err) {
      console.warn(`[cron-trigger] failed to register ${row.id}: ${safeErrorMessage(err)}`);
      skipped += 1;
    }
  }
  return { registered, skipped };
}
