/**
 * In-process JobRunner — no external dependencies.
 *
 * Backup runs are persistent via the `backup_run` table: a row with
 * status='queued' IS a pending job. The runner has two parts:
 *
 *   1. A `setImmediate` fast-path that fires processRun on
 *      enqueueRun() — keeps "Backup now" feeling instant.
 *   2. A 30-second polling loop that picks up any queued rows the
 *      fast-path missed (process crashed between row-create and
 *      processRun call, or a different node inserted it). This makes
 *      the runner correct across restarts WITHOUT needing Redis.
 *
 * Recurring jobs are in-memory cron-parser-driven setTimeout chains.
 * On process restart they're re-registered from the DB by the cron
 * trigger module's `reconcileAllSchedules`, so nothing is lost
 * persistently — the schedule lives in backup_policy.cron_expression.
 *
 * Concurrency: a simple semaphore caps concurrent processRun calls
 * (default 2 — same as the BullMQ runner). Beyond that, jobs sit in
 * the queue until a slot opens.
 */

import cronParser from "cron-parser";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { JobRunner } from "./types";

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface RecurringSchedule {
  jobId: string;
  cronExpression: string;
  onTick: () => Promise<void>;
  timer: NodeJS.Timeout | null;
}

export class InProcessJobRunner implements JobRunner {
  readonly name = "in-process" as const;

  private processRun: ((runId: string) => Promise<void>) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly recurring = new Map<string, RecurringSchedule>();
  private readonly inFlight = new Set<string>();
  private readonly activeTasks = new Set<Promise<unknown>>();
  private readonly enqueueQueue: string[] = [];
  private readonly maxConcurrency = DEFAULT_CONCURRENCY;
  private shuttingDown = false;
  private started = false;
  private closed = false;

  async start(opts: { processRun: (runId: string) => Promise<void> }): Promise<void> {
    if (this.started) return;
    this.shuttingDown = false;
    this.closed = false;
    this.started = true;
    this.processRun = opts.processRun;

    // Sweep any queued runs left over from a previous boot (BullMQ would
    // pick these up automatically; here we have to scan + enqueue).
    await this.requeueOrphanedRuns();
    for (const entry of this.recurring.values()) this.armNextTick(entry);

    // Poll periodically — backstop for runs the fast-path missed.
    this.pollTimer = setInterval(() => {
      void this.track(() => this.poll()).catch((err) =>
        console.warn("[job-runner:in-process] poll error:", err),
      );
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  async shutdown(deadlineMs = 30_000): Promise<void> {
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Stop every recurring timer.
    for (const r of this.recurring.values()) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
    }
    this.recurring.clear();
    // A tick or poll already in progress can still enqueue work. Drain all
    // accepted work, including the fast path that has not reached setImmediate.
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      await this.drainQueue();
      if (!this.activeTasks.size && (!this.processRun || !this.enqueueQueue.length)) break;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.activeTasks]),
          ...(Number.isFinite(deadlineMs) ? [new Promise<void>(resolve => {
            timer = setTimeout(resolve, Math.max(0, deadlineMs - (Date.now() - start)));
          })] : []),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (this.activeTasks.size > 0) {
      console.warn(
        `[job-runner:in-process] shutdown deadline passed with ${this.activeTasks.size} active tasks`,
      );
    }
    this.closed = true;
    this.started = false;
  }

  async enqueueRun(runId: string): Promise<void> {
    if (this.closed) throw new Error("Job runner is closed");
    // Fast path — fire as soon as the event loop yields. The persistent
    // row in backup_run guarantees crash-safety; the next poll picks it
    // up if we crash before fire.
    if (!this.inFlight.has(runId) && !this.enqueueQueue.includes(runId)) this.enqueueQueue.push(runId);
    setImmediate(() => void this.drainQueue());
  }

  async scheduleRecurring(opts: {
    jobId: string;
    cronExpression: string;
    onTick: () => Promise<void>;
  }): Promise<void> {
    if (this.shuttingDown) return;
    // Replace any existing schedule with the same id.
    await this.removeRecurring(opts.jobId);

    const entry: RecurringSchedule = {
      jobId: opts.jobId,
      cronExpression: opts.cronExpression,
      onTick: opts.onTick,
      timer: null,
    };
    this.recurring.set(opts.jobId, entry);
    this.armNextTick(entry);
  }

  async removeRecurring(jobId: string): Promise<void> {
    const existing = this.recurring.get(jobId);
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    this.recurring.delete(jobId);
  }

  describe(): string {
    return `in-process (no Redis required)`;
  }

  // ── Internals ───────────────────────────────────────────────────────

  /** Arm a setTimeout chain that fires the cron expression's next tick,
   *  then re-arms itself for the tick after that. */
  private armNextTick(entry: RecurringSchedule): void {
    if (this.shuttingDown || !this.started || this.recurring.get(entry.jobId) !== entry) return;
    let nextMs: number;
    try {
      const interval = cronParser.parseExpression(entry.cronExpression);
      nextMs = Math.max(0, interval.next().getTime() - Date.now());
    } catch (err) {
      console.warn(
        `[job-runner:in-process] invalid cron "${entry.cronExpression}" for ${entry.jobId} — schedule disabled`,
      );
      this.recurring.delete(entry.jobId);
      return;
    }

    entry.timer = setTimeout(() => {
      // Re-check we're still registered + not shutting down — caller
      // may have removed us during the wait.
      if (this.shuttingDown || this.recurring.get(entry.jobId) !== entry) return;
      entry.timer = null;
      // Node turns an overflowing timeout into 1ms. A monthly/yearly policy
      // must wait, not fire continuously until its real cron date arrives.
      if (nextMs > MAX_TIMER_DELAY_MS) { this.armNextTick(entry); return; }
      void this.track(async () => {
        try {
          await entry.onTick();
        } catch (err) {
          console.warn(
            `[job-runner:in-process] recurring ${entry.jobId} failed:`,
            safeErrorMessage(err),
          );
        }
        // A replacement registered while this callback awaited owns the next tick.
        this.armNextTick(entry);
      });
    }, Math.min(nextMs, MAX_TIMER_DELAY_MS));
    entry.timer.unref();
  }

  private async drainQueue(): Promise<void> {
    if (this.closed || !this.processRun) return;
    while (
      this.enqueueQueue.length > 0 &&
      this.inFlight.size < this.maxConcurrency
    ) {
      const runId = this.enqueueQueue.shift();
      if (!runId) break;
      if (this.inFlight.has(runId)) continue; // dedupe
      this.inFlight.add(runId);
      void this.track(async () => {
        try {
          await this.processRun!(runId);
        } catch (err) {
          console.error(
            `[job-runner:in-process] run ${runId} crashed:`,
            safeErrorMessage(err),
          );
        } finally {
          this.inFlight.delete(runId);
          if (this.enqueueQueue.length > 0) void this.drainQueue();
        }
      });
    }
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(work);
    this.activeTasks.add(task);
    void task.then(() => this.activeTasks.delete(task), () => this.activeTasks.delete(task));
    return task;
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    // Pull queued runs that nobody's claimed yet. Limit pulled per cycle
    // so we don't blow concurrency in one shot — drainQueue handles
    // throttling.
    try {
      const queued = await repos.backupRun.listQueued(20);
      for (const run of queued) {
        if (!this.inFlight.has(run.id) && !this.enqueueQueue.includes(run.id)) {
          this.enqueueQueue.push(run.id);
        }
      }
      if (this.enqueueQueue.length > 0) void this.drainQueue();
    } catch (err) {
      console.warn(
        "[job-runner:in-process] poll query failed:",
        safeErrorMessage(err),
      );
    }
  }

  /** Boot-time: re-queue any runs that were left in 'queued' state by
   *  a previous process. Strictly we could just rely on the poller, but
   *  doing this explicitly at startup makes the first-tick latency
   *  zero instead of up to POLL_INTERVAL_MS. */
  private async requeueOrphanedRuns(): Promise<void> {
    try {
      const queued = await repos.backupRun.listQueued(100);
      for (const run of queued) {
        this.enqueueQueue.push(run.id);
      }
      if (this.enqueueQueue.length > 0) void this.drainQueue();
    } catch (err) {
      console.warn(
        "[job-runner:in-process] boot requeue failed:",
        safeErrorMessage(err),
      );
    }
  }
}
