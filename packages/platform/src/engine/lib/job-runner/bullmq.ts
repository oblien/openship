/**
 * BullMQ-backed JobRunner.
 *
 * Owns three queues:
 *   `backup-run`       — one-shot run jobs. Concurrency 2 per worker.
 *   `backup-schedule`  — repeat jobs for cron-scheduled policies. Each
 *                        tick enqueues an onTick callback invocation.
 *   `backup-recurring` — repeat jobs for system-internal recurring
 *                        tasks (retention prune, etc.). Same shape as
 *                        backup-schedule but separated so we don't
 *                        mix user policies and infrastructure jobs.
 *
 * The recurring-job callback is in-memory (a Map<jobId, onTick>).
 * BullMQ has the cron schedule + fires at each tick; the worker
 * receives only the jobId and looks up the callback.
 */

import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import type { JobRunner } from "./types";

const Q_RUN = "backup-run";
const Q_RECURRING = "backup-recurring";

export class BullMQJobRunner implements JobRunner {
  readonly name = "bullmq" as const;

  private connection: IORedis | null = null;
  private runQueue: Queue<{ runId: string }> | null = null;
  private recurringQueue: Queue<{ jobId: string }> | null = null;
  private runWorker: Worker<{ runId: string }> | null = null;
  private recurringWorker: Worker<{ jobId: string }> | null = null;
  private readonly recurringCallbacks = new Map<string, () => Promise<void>>();
  private started = false;

  private getConnection(): IORedis {
    if (!this.connection) {
      this.connection = new IORedis(env.REDIS_URL, {
        lazyConnect: false,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      this.connection.on("error", (err) => {
        console.warn("[job-runner:bullmq] Redis error:", err.message);
      });
    }
    return this.connection;
  }

  private connectionOpts(): ConnectionOptions {
    // bullmq's bundled ioredis types diverge from ours; structurally
    // compatible, cast through unknown.
    return this.getConnection() as unknown as ConnectionOptions;
  }

  async start(opts: { processRun: (runId: string) => Promise<void> }): Promise<void> {
    if (this.started) return;
    this.started = true;

    const conn = this.connectionOpts();
    const namespace = process.env.OPENSHIP_INSTANCE_NAMESPACE;
    // Omit an absent prefix so BullMQ retains its existing queue and client defaults.
    const queueScope = namespace ? { prefix: namespace } : {};

    this.runQueue = new Queue(Q_RUN, {
      ...queueScope,
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 1000 },
      },
    });
    this.recurringQueue = new Queue(Q_RECURRING, {
      ...queueScope,
      connection: conn,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    });

    this.runWorker = new Worker<{ runId: string }>(
      Q_RUN,
      async (job) => {
        const { runId } = job.data;
        if (!runId) throw new Error("backup-run job missing runId");
        await opts.processRun(runId);
      },
      { connection: conn, concurrency: 2, ...queueScope },
    );

    this.recurringWorker = new Worker<{ jobId: string }>(
      Q_RECURRING,
      async (job) => {
        const { jobId } = job.data;
        const cb = this.recurringCallbacks.get(jobId);
        if (!cb) {
          // Stale schedule — onTick was unregistered before the tick.
          // Removing the BullMQ repeatable would be ideal but the
          // worker only sees the job; the caller's removeRecurring
          // handles it on the next sync.
          return;
        }
        await cb();
      },
      { connection: conn, concurrency: 4, ...queueScope },
    );

    this.runWorker.on("failed", (job, err) =>
      console.error(`[job-runner:bullmq:run] job ${job?.id} failed:`, err.message),
    );
    this.recurringWorker.on("failed", (job, err) =>
      console.error(`[job-runner:bullmq:recurring] job ${job?.id} failed:`, err.message),
    );
  }

  async shutdown(_deadlineMs = 30_000): Promise<void> {
    await Promise.allSettled([this.runWorker?.close(), this.recurringWorker?.close()]);
    await Promise.allSettled([this.runQueue?.close(), this.recurringQueue?.close()]);
    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch {
        // best-effort
      }
      this.connection = null;
    }
    this.started = false;
  }

  async enqueueRun(runId: string): Promise<void> {
    if (!this.runQueue) throw new Error("BullMQJobRunner not started");
    await this.runQueue.add(
      "run",
      { runId },
      {
        jobId: runId, // dedupe replays of the same runId
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
  }

  async scheduleRecurring(opts: {
    jobId: string;
    cronExpression: string;
    onTick: () => Promise<void>;
  }): Promise<void> {
    if (!this.recurringQueue) throw new Error("BullMQJobRunner not started");
    this.recurringCallbacks.set(opts.jobId, opts.onTick);

    // Remove any existing repeatable with the same jobId so cron edits
    // take effect. BullMQ keys repeatables by `pattern + jobId`; we
    // iterate to find a match.
    const repeatables = await this.recurringQueue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === opts.jobId) {
        await this.recurringQueue.removeRepeatableByKey(r.key);
      }
    }

    await this.recurringQueue.add(
      opts.jobId,
      { jobId: opts.jobId },
      {
        jobId: opts.jobId,
        repeat: { pattern: opts.cronExpression },
        attempts: 1,
      },
    );
  }

  async removeRecurring(jobId: string): Promise<void> {
    this.recurringCallbacks.delete(jobId);
    if (!this.recurringQueue) return;
    const repeatables = await this.recurringQueue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === jobId) await this.recurringQueue.removeRepeatableByKey(r.key);
    }
  }

  describe(): string {
    return `bullmq (Redis @ ${env.REDIS_URL})`;
  }
}
