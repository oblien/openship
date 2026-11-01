import { eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { systemNotice } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SystemNotice = typeof systemNotice.$inferSelect;
export type NewSystemNotice = typeof systemNotice.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createSystemNoticeRepo(db: Database) {
  return {
    /** Active notices whose optional [startsAt, endsAt] window contains `now`.
     *  Filtered in JS (the active set is tiny) so a null bound is open-ended. */
    async listActive(now: Date = new Date()): Promise<SystemNotice[]> {
      const rows = await db.query.systemNotice.findMany({
        where: eq(systemNotice.active, true),
      });
      return rows
        .filter((r) => (!r.startsAt || r.startsAt <= now) && (!r.endsAt || r.endsAt >= now))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    /** Every notice (operator listing — includes inactive/expired). */
    async list(): Promise<SystemNotice[]> {
      const rows = await db.query.systemNotice.findMany();
      return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async create(data: Omit<NewSystemNotice, "id">): Promise<SystemNotice> {
      const id = generateId("ntc");
      const row = { id, ...data };
      const [created] = await db.insert(systemNotice).values(row).returning();
      return created!;
    },

    /** Operators clear a notice by deactivating it (kept for history/audit). */
    async deactivate(id: string): Promise<void> {
      await db
        .update(systemNotice)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(systemNotice.id, id));
    },
  };
}
