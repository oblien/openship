import { eq, lt } from "drizzle-orm";
import type { Database } from "../client";
import { gitlabWebhookEvent } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GitlabWebhookEvent = typeof gitlabWebhookEvent.$inferSelect;
export type NewGitlabWebhookEvent = typeof gitlabWebhookEvent.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGitlabWebhookEventRepo(db: Database) {
  return {
    /**
     * Atomically claim a delivery id. Returns true if THIS caller inserted the
     * row (first time we've seen this delivery), false if it already existed.
     */
    async claim(deliveryId: string, eventType: string): Promise<boolean> {
      const rows = await db
        .insert(gitlabWebhookEvent)
        .values({ deliveryId, eventType })
        .onConflictDoNothing()
        .returning();
      return rows.length > 0;
    },

    /** Stamp a delivery as fully handled (best-effort observability). */
    async markProcessed(deliveryId: string): Promise<void> {
      await db
        .update(gitlabWebhookEvent)
        .set({ processedAt: new Date() })
        .where(eq(gitlabWebhookEvent.deliveryId, deliveryId));
    },

    /**
     * Delete claim rows older than `cutoff`. Idempotency only needs a recent
     * window, so old rows are safe to drop. Returns rows deleted.
     */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(gitlabWebhookEvent)
        .where(lt(gitlabWebhookEvent.receivedAt, cutoff))
        .returning();
      return rows.length;
    },
  };
}
