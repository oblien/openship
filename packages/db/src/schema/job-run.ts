import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

/**
 * job_run — history of scheduled system tasks (SSL renewal, orphan GC, prunes,
 * later custom jobs). One row per execution.
 *
 * The shared JobRunner already schedules these; this table makes them
 * observable: last run, next-run is derivable from the schedule, outcome, and
 * duration. It is NOT the queue (backups keep backup_run for that) — it is an
 * append-only audit of ticks, keyed by the runner `jobId` (e.g. "ssl:renew",
 * "projects:orphan-gc").
 *
 * System-wide, not org-scoped: these jobs act across the whole instance, so
 * there's no organizationId. Custom per-org jobs (a later phase) can add one.
 */
export const jobRun = pgTable(
  "job_run",
  {
    id: text("id").primaryKey(),
    /** Stable runner job id — matches JobRunner.scheduleRecurring jobId. */
    jobId: text("job_id").notNull(),
    /** system (built-in) | custom (operator-defined, future). */
    kind: text("kind").notNull().default("system"),
    /** schedule (cron) | manual (Run now) | once | dependency | event. */
    trigger: text("trigger").notNull().default("schedule"),
    /** running | success | failed. */
    status: text("status").notNull(),
    /** Single target, or null for a multi-server aggregate/builtin. */
    serverId: text("server_id"),
    /** Immutable command targets at acceptance; null for builtins and legacy rows. */
    serverIds: text("server_ids").array(),
    /** Retry attempt number (1-based); one run row per attempt. */
    attempt: integer("attempt").notNull().default(1),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    /** Null while running. */
    finishedAt: timestamp("finished_at"),
    durationMs: integer("duration_ms"),
    /** Small outcome shape, e.g. { renewed, failed, total } or { reclaimed }. */
    summary: jsonb("summary"),
    /** Captured stdout/stderr for custom command jobs (null for builtin jobs,
     *  which only produce a structured summary). Batch — stored on finish. */
    output: text("output"),
    /** Failure message (status = failed). */
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Primary access pattern: recent runs for one job, newest first.
    index("job_run_job_started_idx").on(t.jobId, t.startedAt),
  ],
);
