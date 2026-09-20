import { eq, and, desc, isNull, sql } from "drizzle-orm";
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
      const [row] = await db.insert(incomingWebhook).values({ ...data, id }).returning();
      return row!;
    },

    async update(id: string, data: Partial<NewIncomingWebhook>): Promise<void> {
      await db
        .update(incomingWebhook)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(incomingWebhook.id, id));
    },

    /** Credential disclosure must apply to the exact action that was authorized. */
    async updateIfUnchanged(expected: IncomingWebhook, data: Partial<NewIncomingWebhook>): Promise<IncomingWebhook | null> {
      const nullable = (column: typeof incomingWebhook.tokenEncrypted | typeof incomingWebhook.hmacSecretEncrypted, value: string | null) => value === null ? isNull(column) : eq(column, value);
      const [row] = await db.update(incomingWebhook).set({ ...data, updatedAt: new Date() }).where(and(
        eq(incomingWebhook.id, expected.id), eq(incomingWebhook.projectId, expected.projectId),
        eq(incomingWebhook.actionType, expected.actionType), eq(incomingWebhook.authMode, expected.authMode),
        eq(incomingWebhook.enabled, expected.enabled), eq(incomingWebhook.name, expected.name),
        sql`${incomingWebhook.actionConfig} = ${JSON.stringify(expected.actionConfig ?? {})}::jsonb`,
        nullable(incomingWebhook.tokenEncrypted, expected.tokenEncrypted),
        nullable(incomingWebhook.hmacSecretEncrypted, expected.hmacSecretEncrypted),
        expected.executionAuthority == null ? isNull(incomingWebhook.executionAuthority)
          : sql`${incomingWebhook.executionAuthority} = ${JSON.stringify(expected.executionAuthority)}::jsonb`,
      )).returning();
      return row ?? null;
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
