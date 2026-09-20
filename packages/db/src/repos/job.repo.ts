/**
 * job repo — scheduled-task definitions (the schedule). Reconciled onto the
 * runner at boot; job_run holds execution history.
 */

import { asc, eq, inArray } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { job } from "../schema/job";

export type Job = typeof job.$inferSelect;
export type NewJob = typeof job.$inferInsert;

export function createJobRepo(db: Database) {
  return {
    async findByKey(key: string): Promise<Job | null> {
      const rows = await db.select().from(job).where(eq(job.key, key)).limit(1);
      return rows[0] ?? null;
    },

    async listAll(): Promise<Job[]> {
      return db.select().from(job).orderBy(asc(job.kind), asc(job.label));
    },

    /**
     * Batch id → display label, for naming jobs in list responses (the audit
     * feed). Audit rows carry the job id, not its key.
     */
    async listNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
      if (ids.length === 0) return [];
      return db.select({ id: job.id, name: job.label }).from(job).where(inArray(job.id, ids));
    },

    /**
     * Seed/refresh a built-in system job. Creates it with the default cron +
     * enabled on first boot; on later boots only the label is refreshed so an
     * operator's cron/enabled overrides survive.
     */
    async upsertSystem(data: {
      key: string;
      label: string;
      defaultCron: string;
    }): Promise<Job> {
      const now = new Date();
      const [row] = await db
        .insert(job)
        .values({
          id: generateId("job"),
          key: data.key,
          kind: "system",
          label: data.label,
          cronExpression: data.defaultCron,
          enabled: true,
          actionType: "builtin",
        })
        // Boot reconciliation and a request-side self-heal can race. The key is
        // the single owner identity, so converge on that row instead of letting
        // the losing insert fail. Only code-owned display metadata is refreshed;
        // the operator's enabled/cron choices remain authoritative.
        .onConflictDoUpdate({
          target: job.key,
          set: { label: data.label, updatedAt: now },
        })
        .returning();
      return row;
    },

    async update(
      key: string,
      patch: Partial<
        Pick<
          NewJob,
          | "cronExpression"
          | "enabled"
          | "label"
          | "scheduleType"
          | "runAt"
          | "actionConfig"
          | "dependsOn"
          | "triggerEvents"
          | "notifyConfig"
        >
      >,
    ): Promise<void> {
      await db
        .update(job)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(job.key, key));
    },

    async create(data: Omit<NewJob, "id" | "createdAt" | "updatedAt">): Promise<Job> {
      const row: NewJob = { id: generateId("job"), ...data };
      await db.insert(job).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Job;
    },

    async remove(key: string): Promise<void> {
      await db.delete(job).where(eq(job.key, key));
    },
  };
}
