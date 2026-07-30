import { eq, and } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { webhookSource } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WebhookSource = typeof webhookSource.$inferSelect;
export type NewWebhookSource = typeof webhookSource.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createWebhookSourceRepo(db: Database) {
  return {
    async get(id: string) {
      return db.query.webhookSource.findFirst({ where: eq(webhookSource.id, id) });
    },

    /** Every source for an org — the Settings list. */
    async listByOrg(organizationId: string): Promise<WebhookSource[]> {
      return db.query.webhookSource.findMany({
        where: eq(webhookSource.organizationId, organizationId),
      });
    },

    /** Enabled sources of a kind — the receiver's secret-resolution set. */
    async listEnabledByKind(kind: string): Promise<WebhookSource[]> {
      return db.query.webhookSource.findMany({
        where: and(eq(webhookSource.kind, kind), eq(webhookSource.enabled, true)),
      });
    },

    async create(data: Omit<NewWebhookSource, "id">): Promise<WebhookSource> {
      const id = generateId("whs");
      const row = { id, ...data };
      await db.insert(webhookSource).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as WebhookSource;
    },

    async update(id: string, data: Partial<NewWebhookSource>) {
      await db
        .update(webhookSource)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(webhookSource.id, id));
    },

    async remove(id: string) {
      await db.delete(webhookSource).where(eq(webhookSource.id, id));
    },

    /** Scoped delete — guards a mutation to the org's own source. */
    async removeForOrg(organizationId: string, id: string) {
      await db
        .delete(webhookSource)
        .where(and(eq(webhookSource.organizationId, organizationId), eq(webhookSource.id, id)));
    },
  };
}
