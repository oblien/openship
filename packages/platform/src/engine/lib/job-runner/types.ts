/**
 * Job runner abstraction — two interchangeable backends:
 *
 *   "bullmq"      Redis-backed via BullMQ. Used when REDIS_URL is reachable.
 *                 Persistent jobs survive process restart, distributed
 *                 worker coordination, sophisticated retry semantics.
 *                 Production / SaaS default.
 *
 *   "in-process"  No external deps. Polls Postgres for `status='queued'`
 *                 backup_run rows; schedules via in-memory cron-parser
 *                 timers. Self-hosted + desktop default. Loses any
 *                 in-memory cron timer state on restart, which is fine
 *                 because schedules are persisted in backup_policy and
 *                 re-registered on boot. Loses no actual backup work
 *                 because the `backup_run` row IS the job queue —
 *                 status flips back to "queued" via the stale-run sweep
 *                 + re-enqueueing.
 *
 * Both backends implement this contract. Every caller (orchestrator,
 * cron trigger, retention prune) talks to the interface — none knows
 * which backend is live.
 */

export interface JobRunner {
  readonly name: "bullmq" | "in-process";

  /** Start the runner. Wires the job processor that runs when a
   *  `enqueueRun` job is picked up. Idempotent — calling twice is a
   *  no-op on the second call. */
  start(opts: { processRun: (runId: string) => Promise<void> }): Promise<void>;

  /** Stop the runner gracefully. Waits up to `deadlineMs` for in-flight
   *  jobs to finish. SIGTERM handler calls this. */
  shutdown(deadlineMs?: number): Promise<void>;

  /** Enqueue a one-shot backup run. The runner will eventually call
   *  the processRun callback registered at start time. Persistent on
   *  BullMQ (survives restart); on in-process the run survives in the
   *  DB and the next boot's poller picks it up. */
  enqueueRun(runId: string): Promise<void>;

  /** Register a recurring cron-scheduled job. Idempotent — registering
   *  the same jobId replaces any existing schedule (so policy cron
   *  edits take effect immediately). */
  scheduleRecurring(opts: {
    jobId: string;
    cronExpression: string;
    onTick: () => Promise<void>;
  }): Promise<void>;

  /** Remove a recurring job. Safe to call when none exists. */
  removeRecurring(jobId: string): Promise<void>;

  /** Describe the runner for logs / diagnostics. */
  describe(): string;
}
