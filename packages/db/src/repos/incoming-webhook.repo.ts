import { eq, and, desc } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { incomingWebhook } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type IncomingWebhook = typeof incomingWebhook.$inferSelect;
export type NewIncomingWebhook = typeof incomingWebhook.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createIncomingWebhookRepo(db: Database) {
  return {
    async findById(id: string): Promise<IncomingWebhook | undefined> {
      return db.query.incomingWebhook.findFirst({ where: eq(incomingWebhook.id, id) });
    },

    /** All hooks for a project — the project-settings list (newest first). */
    async listByProject(projectId: string): Promise<IncomingWebhook[]> {
      return db.query.incomingWebhook.findMany({
        where: eq(incomingWebhook.projectId, projectId),
        orderBy: [desc(incomingWebhook.createdAt)],
      });
    },

    async create(data: Omit<NewIncomingWebhook, "id">): Promise<IncomingWebhook> {
      const id = generateId("iwh");
      const row = { id, ...data };
      await db.insert(incomingWebhook).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as IncomingWebhook;
    },

    async update(id: string, data: Partial<NewIncomingWebhook>): Promise<void> {
      await db
        .update(incomingWebhook)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(incomingWebhook.id, id));
    },

    /** Scoped delete — guards the mutation to the hook's own project. */
    async removeForProject(projectId: string, id: string): Promise<void> {
      await db
        .delete(incomingWebhook)
        .where(and(eq(incomingWebhook.projectId, projectId), eq(incomingWebhook.id, id)));
    },

    async markFired(id: string): Promise<void> {
      await db
        .update(incomingWebhook)
        .set({ lastFiredAt: new Date() })
        .where(eq(incomingWebhook.id, id));
    },
  };
}
