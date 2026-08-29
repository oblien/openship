import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { mailInboundRule } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MailInboundRule = typeof mailInboundRule.$inferSelect;
export type NewMailInboundRule = typeof mailInboundRule.$inferInsert;

/**
 * What a rule watches.
 *
 * `all` means every domain on the server. It is a genuine fan-out rather than a flag:
 * the shipped Postfix config has no global BCC and its domain lookup keys on exact
 * equality, so `all` arms one row per domain and needs a reconcile when a domain is added.
 */
export type MailInboundScope = "mailbox" | "domain" | "all";

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Rules only. There is deliberately no collector/cursor table: what is armed lives in the
 * engine's own `vmail` DB (the token is inside `recipient_bcc_domain.bcc_address`, the
 * maildir in `vmail.mailbox`), and the read job's cursor is the deletion of the message it
 * just dispatched. Mirroring either here would be a cache of somebody else's truth.
 */
export function createMailInboundRepo(db: Database) {
  return {
    async listByServer(serverId: string): Promise<MailInboundRule[]> {
      return db.query.mailInboundRule.findMany({
        where: eq(mailInboundRule.serverId, serverId),
      });
    },

    /** The dispatch path's read: only rules that can actually fire. */
    async listEnabledByServer(serverId: string): Promise<MailInboundRule[]> {
      return db.query.mailInboundRule.findMany({
        where: and(
          eq(mailInboundRule.serverId, serverId),
          eq(mailInboundRule.enabled, true),
        ),
      });
    },

    /**
     * Scoped by org as well as id. The route already asserts the server belongs to the
     * caller's org, but a repo method that can be called with an id alone is one refactor
     * away from being the cross-tenant read — so the org is required here too.
     */
    async findById(
      organizationId: string,
      id: string,
    ): Promise<MailInboundRule | undefined> {
      return db.query.mailInboundRule.findFirst({
        where: and(
          eq(mailInboundRule.organizationId, organizationId),
          eq(mailInboundRule.id, id),
        ),
      });
    },

    /** Every enabled rule across the instance, for the sweep that reconciles armed rows. */
    async listEnabled(): Promise<MailInboundRule[]> {
      return db.query.mailInboundRule.findMany({
        where: eq(mailInboundRule.enabled, true),
      });
    },

    async create(input: Omit<NewMailInboundRule, "id">): Promise<MailInboundRule> {
      const [row] = await db
        .insert(mailInboundRule)
        .values({ ...input, id: generateId("mir") })
        .returning();
      return row!;
    },

    async update(
      organizationId: string,
      id: string,
      patch: Partial<Omit<NewMailInboundRule, "id" | "serverId" | "organizationId">>,
    ): Promise<MailInboundRule | undefined> {
      const [row] = await db
        .update(mailInboundRule)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(mailInboundRule.organizationId, organizationId),
            eq(mailInboundRule.id, id),
          ),
        )
        .returning();
      return row;
    },

    /**
     * Burst control: pause with a STATED reason rather than dropping silently. The
     * notification subsystem has no rate limiting of its own, so this is the only place a
     * runaway rule is visible to the operator.
     */
    async pause(id: string, reason: string): Promise<void> {
      await db
        .update(mailInboundRule)
        .set({ pausedReason: reason, updatedAt: new Date() })
        .where(eq(mailInboundRule.id, id));
    },

    async resume(id: string): Promise<void> {
      await db
        .update(mailInboundRule)
        .set({ pausedReason: null, updatedAt: new Date() })
        .where(eq(mailInboundRule.id, id));
    },

    async markMatched(id: string): Promise<void> {
      await db
        .update(mailInboundRule)
        .set({ lastMatchedAt: new Date(), updatedAt: new Date() })
        .where(eq(mailInboundRule.id, id));
    },

    async remove(organizationId: string, id: string): Promise<void> {
      await db
        .delete(mailInboundRule)
        .where(
          and(
            eq(mailInboundRule.organizationId, organizationId),
            eq(mailInboundRule.id, id),
          ),
        );
    },
  };
}
