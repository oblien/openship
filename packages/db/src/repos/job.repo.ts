/**
 * job repo — scheduled-task definitions (the schedule). Reconciled onto the
 * runner at boot; job_run holds execution history.
 */

import { asc, eq } from "drizzle-orm";
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
     * Seed/refresh a built-in system job. Creates it with the default cron +
     * enabled on first boot; on later boots only the label is refreshed so an
     * operator's cron/enabled overrides survive.
     */
    async upsertSystem(data: {
      key: string;
      label: string;
      defaultCron: string;
    }): Promise<Job> {
      const existing = await this.findByKey(data.key);
      if (existing) {
        if (existing.label !== data.label) {
          await db
            .update(job)
            .set({ label: data.label, updatedAt: new Date() })
            .where(eq(job.key, data.key));
        }
        return { ...existing, label: data.label };
      }
      const row: NewJob = {
        id: generateId("job"),
        key: data.key,
        kind: "system",
        label: data.label,
        cronExpression: data.defaultCron,
        enabled: true,
        actionType: "builtin",
      };
      await db.insert(job).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Job;
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
