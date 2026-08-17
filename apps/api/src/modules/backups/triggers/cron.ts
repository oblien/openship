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
import { repos, type BackupPolicy } from "@repo/db";
import { getJobRunner } from "../../../lib/job-runner";
import { safeErrorMessage } from "@repo/core";
import { backupOrchestrator } from "../backup.orchestrator";

async function serverIdForBackupPolicy(policy: BackupPolicy): Promise<string | null> {
  if (policy.projectId) {
    const project = await repos.project.findById(policy.projectId);
    return project?.serverId ?? null;
  }
  // mail_servers.server_id is the host servers.id
  return policy.mailServerId ?? null;
}

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
      const { dispatchToAgent } = await import("../../system/server-agent");
      const serverId = await serverIdForBackupPolicy(fresh);
      if (serverId) {
        const dispatched = await dispatchToAgent(serverId, "run_backup", { policyId }).catch(() => null);
        // Agent returns skipped when it has no local producer plan — keep today's path.
        if (dispatched?.ok && !dispatched.skipped) return;
      }
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
