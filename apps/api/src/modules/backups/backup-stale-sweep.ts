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

import { repos } from "@repo/db";
import type { JobSummary } from "../../lib/system-jobs";

/** Matches `DEFAULT_HELPER_IDLE_MS` in the docker backup executor. */
export const BACKUP_RUN_IDLE_STALE_MS = 10 * 60 * 1000;
/** Matches `DEFAULT_HELPER_TIMEOUT_MS` in the docker backup executor. */
export const BACKUP_RUN_CEILING_STALE_MS = 6 * 60 * 60 * 1000;

const STALE_REASON =
  "Backup run made no progress within the configured timeout and was reconciled.";

export async function runBackupStaleSweep(): Promise<JobSummary> {
  const now = Date.now();
  const swept = await repos.backupRun.sweepRunsWithStaleHeartbeat({
    idleCutoff: new Date(now - BACKUP_RUN_IDLE_STALE_MS),
    ceilingCutoff: new Date(now - BACKUP_RUN_CEILING_STALE_MS),
    reason: STALE_REASON,
  });
  if (swept > 0) {
    console.warn(`[backup-stale-sweep] reconciled ${swept} stale backup run(s)`);
  }
  return { swept };
}
