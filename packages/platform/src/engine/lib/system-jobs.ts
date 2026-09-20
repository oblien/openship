/**
 * System jobs — the standard, observable way to run recurring instance-wide
 * tasks (SSL renewal, orphan GC, prunes, …).
 *
 * `scheduleSystemJob` registers a recurring job on the shared JobRunner AND
 * records every tick in `job_run`, so the task shows up in the Jobs read-model
 * (last run, outcome, duration) instead of running invisibly. Use it in place
 * of `runner.scheduleRecurring` for any built-in periodic task.
 *
 * `recordJobRun` is the same recording wrapper exposed directly, for a future
 * "Run now" (trigger:"manual") path.
 *
 * These are NOT the backup queue — backups keep their own run/policy tables.
 * This is scheduling + history for the code-defined system sweeps.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { getJobRunner } from "@repo/platform/engine/lib/job-runner/index";
import { trackBackgroundWork } from "./background-work";

/** A tick's outcome — a small JSON-able summary, or nothing. */
export type JobSummary = Record<string, unknown> | void;

/** Generous default cap on a single tick's body, so a hung system task fails
 *  its run (and unblocks the in-process scheduler) instead of hanging forever.
 *  Override per job via `recordJobRun(..., { timeoutMs })` for genuinely long
 *  sweeps. */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run a job body once, wrapping it in a `job_run` history row: opens a
 * "running" row, then closes it "success" (+ summary + duration) or "failed"
 * (+ error). Re-throws so callers can react; the scheduler wrapper swallows to
 * keep the recurring tick alive.
 */
export async function recordJobRun(
  jobId: string,
  opts: { trigger?: "schedule" | "manual"; kind?: string; timeoutMs?: number },
  fn: () => Promise<JobSummary>,
): Promise<JobSummary> {
  const startedMs = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const run = await repos.jobRun.start({
    jobId,
    kind: opts.kind,
    trigger: opts.trigger ?? "schedule",
  });
  // Time-box the body. A handler that never resolves would otherwise leave the
  // row stuck "running" forever AND (in-process) freeze the whole scheduler,
  // since armNextTick only re-arms after onTick settles. We can't cancel `fn`
  // (its promise stays owned and is drained before native shutdown), but racing a
  // timeout guarantees the row is finalized and the tick completes. The default
  // is generous so legitimate long runs aren't affected.
  let timer: NodeJS.Timeout | undefined;
  try {
    const summary = await Promise.race([
      trackBackgroundWork(Promise.resolve().then(fn)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Job timed out after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]);
    await repos.jobRun.finish(run.id, {
      status: "success",
      durationMs: Date.now() - startedMs,
      summary: summary && typeof summary === "object" ? summary : undefined,
    });
    return summary;
  } catch (err) {
    await repos.jobRun.finish(run.id, {
      status: "failed",
      durationMs: Date.now() - startedMs,
      error: safeErrorMessage(err),
    });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Register (or refresh) a recurring system job on the shared runner. Idempotent
 * per jobId. Every tick is recorded via recordJobRun; a failing tick is logged
 * and recorded but never crashes the runner.
 */
export async function scheduleSystemJob(opts: {
  jobId: string;
  cronExpression: string;
  run: () => Promise<JobSummary>;
}): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: opts.jobId,
    cronExpression: opts.cronExpression,
    onTick: async () => {
      try {
        await recordJobRun(opts.jobId, { trigger: "schedule" }, opts.run);
      } catch (err) {
        console.error(`[system-job] ${opts.jobId} failed:`, safeErrorMessage(err));
      }
    },
  });
}
