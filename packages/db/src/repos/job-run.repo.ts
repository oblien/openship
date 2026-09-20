/**
 * job_run repo — append-only history of scheduled system-task executions.
 *
 * `start` opens a "running" row; `finish` closes it with outcome + duration.
 * Reads power the Jobs read-model (recent runs per job, last outcome).
 */

import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { jobRun } from "../schema/job-run";

export type JobRun = typeof jobRun.$inferSelect;
export type NewJobRun = typeof jobRun.$inferInsert;

export function createJobRunRepo(db: Database) {
  return {
    /** Open a running row for a job tick. */
    async start(data: {
      jobId: string;
      kind?: string;
      trigger?: string;
      serverId?: string | null;
      serverIds?: string[];
      attempt?: number;
    }): Promise<JobRun> {
      const id = generateId("jrun");
      const row: NewJobRun = {
        id,
        jobId: data.jobId,
        kind: data.kind ?? "system",
        trigger: data.trigger ?? "schedule",
        status: "running",
        serverId: data.serverId ?? null,
        serverIds: data.serverIds ?? null,
        attempt: data.attempt ?? 1,
      };
      await db.insert(jobRun).values(row);
      return { ...row, startedAt: new Date(), createdAt: new Date() } as JobRun;
    },

    /** Close a run row with its outcome. */
    async finish(
      id: string,
      data: {
        status: "success" | "failed";
        durationMs?: number;
        summary?: Record<string, unknown>;
        output?: string;
        error?: string;
      },
    ): Promise<void> {
      await db
        .update(jobRun)
        .set({
          status: data.status,
          finishedAt: new Date(),
          durationMs: data.durationMs,
          summary: data.summary,
          output: data.output,
          error: data.error,
        })
        .where(eq(jobRun.id, id));
    },

    async findById(id: string): Promise<JobRun | undefined> {
      const [row] = await db.select().from(jobRun).where(eq(jobRun.id, id)).limit(1);
      return row;
    },

    /** Recent runs, optionally for a single job, newest first. */
    async listRecent(opts?: { jobId?: string; limit?: number }): Promise<JobRun[]> {
      const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
      const where = opts?.jobId ? eq(jobRun.jobId, opts.jobId) : undefined;
      return db
        .select()
        .from(jobRun)
        .where(where)
        .orderBy(desc(jobRun.startedAt))
        .limit(limit);
    },

    /** Delete rows older than the cutoff (future prune job). */
    async pruneOlderThan(cutoff: Date): Promise<void> {
      await db.delete(jobRun).where(lt(jobRun.startedAt, cutoff));
    },

    /**
     * Close out "running" rows left dangling by a previous process (crash /
     * restart mid-run) — they'd otherwise show as perpetually "Running" in the
     * UI. Marks them failed with an interrupted note. Returns how many were
     * reconciled. SINGLE-BOX ONLY: safe when nothing was running before this
     * boot (self-hosted / in-process); a multi-replica deployment must not call
     * this on one replica's boot (a row may be genuinely running elsewhere).
     */
    async failStaleRunning(
      reason = "Interrupted — the service restarted while this run was in progress",
    ): Promise<number> {
      const rows = await db
        .update(jobRun)
        .set({ status: "failed", finishedAt: new Date(), error: reason })
        .where(and(eq(jobRun.status, "running"), isNull(jobRun.finishedAt)))
        .returning();
      return rows.length;
    },
  };
}
