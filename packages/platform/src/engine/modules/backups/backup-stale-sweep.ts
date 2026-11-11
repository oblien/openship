/**
 * Periodic reconciliation for backup runs stuck in non-terminal states.
 *
 * Boot already calls `sweepStaleRuns` for every in-flight row after a crash,
 * but a wedged `pg_dump` exec (#516) can hang indefinitely without restarting
 * the API — `lastEventAt` stops moving, queued siblings never get a worker
 * slot, and the operator only sees relief after a manual restart.
 *
 * Thresholds mirror the docker exec defaults: 10 minutes of silence, 6 hours
 * absolute.
 *
 * There is deliberately NO separate `queued` window any more. It looked like a way
 * to surface a run that never got a worker slot, but `lastEventAt` does not move
 * while a run waits, so the window measured queue depth and terminalized ordinary
 * runs that were still claimable — permanently, since the write is terminal. Run
 * concurrency is 2, so a project-level policy fanning out over a few services was
 * enough to trip it. Queued rows are recovered by the runner (in-process polls
 * `listQueued()` every 30s; BullMQ is durable), and the 6h ceiling still catches a
 * row that has genuinely gone nowhere. See `sweepRunsWithStaleHeartbeat`.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { mapConcurrent } from "@repo/core";
import { env } from "../../config/env";
import { tryWithCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { projectRuntimeLockKey } from "../../lib/project-runtime-lock";
import { tryWithProvisionLock } from "../../lib/provision-lock";
import { readActiveProjectWork } from "../projects/project-active-work";

/** Matches `DEFAULT_HELPER_IDLE_MS` in the docker backup executor. */
export const BACKUP_RUN_IDLE_STALE_MS = 10 * 60 * 1000;
/** Matches `DEFAULT_HELPER_TIMEOUT_MS` in the docker backup executor. */
export const BACKUP_RUN_CEILING_STALE_MS = 6 * 60 * 60 * 1000;

const STALE_REASON =
  "Backup run made no progress within the configured timeout and was reconciled.";

/** Cloud replicas may restart independently, so neither heartbeat age nor a
 * terminal status authorizes unlocking the server. Reuse the worker's exact
 * ownership gates and remote-command recovery, without replaying the backup. */
export async function recoverOrphanedCloudBackupExecutions(): Promise<number> {
  if (!env.CLOUD_MODE) return 0;
  let recovered = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await repos.backupRun.listUnfinishedCloudExecutions(afterId);
    const results = await mapConcurrent(page, 4, async (candidate) => {
      try {
        const workspace = await repos.cloudWorkspace.findById(candidate.workspaceId);
        const scope = `project:${candidate.projectId}`;
        if (
          !workspace ||
          workspace.remote ||
          workspace.organizationId !== candidate.organizationId ||
          (workspace.activity &&
            (workspace.activity.controllerId !== "saas" || workspace.activity.scope !== scope))
        )
          return false;
        const canRecoverProject = async () => {
          const project = await repos.project.findById(candidate.projectId);
          if (
            !project ||
            project.organizationId !== candidate.organizationId ||
            project.workspaceId !== candidate.workspaceId
          )
            return false;
          const work = await readActiveProjectWork(candidate.projectId);
          return !work.activeDeployments.length && !work.restores.length && !work.migration;
        };
        // A project activity may belong to an enclosing deployment or restore.
        // Do not recover its commands on the strength of one backup execution.
        if (!(await canRecoverProject())) return false;
        const activityId = await tryWithCloudWorkspaceActivity(
          candidate.workspaceId,
          async () =>
            tryWithProvisionLock(projectRuntimeLockKey(candidate.projectId), async () => {
              if (!(await canRecoverProject())) return undefined;
              // Admission first confirms every tracked remote request has ended.
              return (await repos.cloudWorkspace.findById(candidate.workspaceId))?.activity?.id;
            }),
          scope,
          { expectedActivityId: workspace.activity?.id ?? null },
        );
        if (!activityId) return false;
        const current = await repos.cloudWorkspace.findById(candidate.workspaceId);
        // Release is best-effort in admission's finally. Keep this candidate
        // discoverable if that write failed, so the next sweep can retry it.
        if (current?.activity?.id === activityId) return false;
        // This execution can never be claimed twice. After proving its worker
        // and remote commands exited, its final acknowledgement is metadata-only.
        return await repos.backupRun.acknowledgeRecoveredExecution(candidate);
      } catch (error) {
        errorDiagnostics.warn(
          "platform/engine/modules/backups/backup-stale-sweep",
          `Backup execution recovery remains pending for ${candidate.runId}`,
          error,
        );
        return false;
      }
    });
    recovered += results.filter(Boolean).length;
    if (page.length < 100) break;
    afterId = page[page.length - 1]!.runId;
  }
  return recovered;
}

export async function runBackupStaleSweep(): Promise<{ swept: number; recovered: number }> {
  const now = Date.now();
  const swept = await repos.backupRun.sweepRunsWithStaleHeartbeat({
    idleCutoff: new Date(now - BACKUP_RUN_IDLE_STALE_MS),
    ceilingCutoff: new Date(now - BACKUP_RUN_CEILING_STALE_MS),
    reason: STALE_REASON,
  });
  if (swept > 0) {
    errorDiagnostics.warn(
      "platform/engine/modules/backups/backup-stale-sweep",
      `[backup-stale-sweep] reconciled ${swept} stale backup run(s)`,
    );
  }
  const recovered = await recoverOrphanedCloudBackupExecutions();
  return { swept, recovered };
}
