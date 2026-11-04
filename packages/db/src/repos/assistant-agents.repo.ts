import { and, eq, desc, sql, or, inArray, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { assistantAgent as agent } from "../schema/assistant-agents";
import { assistantConversation as chat } from "../schema/assistant";
import {
  assistantAutomation as flow,
  assistantAutomationRun as run,
} from "../schema/assistant-automations";
import { personalAccessToken as token } from "../schema/personal-access-token";
import type { AssistantOwner } from "./assistant.repo";
export type AssistantAgentRow = typeof agent.$inferSelect;
export function createAssistantAgentsRepo(db: Database) {
  const scope = (owner: AssistantOwner) =>
    and(eq(agent.userId, owner.userId), eq(agent.organizationId, owner.organizationId));
  return {
    list: (owner: AssistantOwner) =>
      db.select().from(agent).where(scope(owner)).orderBy(desc(agent.createdAt)),
    async find(owner: AssistantOwner, id: string) {
      return (
        await db
          .select()
          .from(agent)
          .where(and(scope(owner), eq(agent.id, id)))
          .limit(1)
      )[0];
    },
    async create(input: typeof agent.$inferInsert) {
      return (await db.insert(agent).values(input).returning())[0]!;
    },
    async setIcon(owner: AssistantOwner, id: string, revision: number, icon: string) {
      // Appearance does not change the execution revision or invalidate active task grants.
      // If work settings changed concurrently, require a fresh editor before saving.
      return (
        await db
          .update(agent)
          .set({ icon })
          .where(and(scope(owner), eq(agent.id, id), eq(agent.revision, revision)))
          .returning()
      )[0];
    },
    async update(
      owner: AssistantOwner,
      id: string,
      revision: number,
      input: Partial<
        Pick<
          AssistantAgentRow,
          "model" | "icon" | "readOnly" | "grants" | "authority" | "nativeRevision" | "archived"
        >
      >,
    ) {
      return db.transaction(async (tx) => {
        const [saved] = await tx
          .update(agent)
          .set({ ...input, revision: sql`${agent.revision} + 1` })
          .where(and(scope(owner), eq(agent.id, id), eq(agent.revision, revision)))
          .returning();
        if (!saved) return;
        const chats = and(
          eq(chat.userId, owner.userId),
          eq(chat.organizationId, owner.organizationId),
          eq(chat.agentId, id),
        );
        const flows = and(
          eq(flow.userId, owner.userId),
          eq(flow.organizationId, owner.organizationId),
          eq(flow.agentId, id),
        );
        // Policy edits and credential invalidation commit together. A remote MCP
        // client cannot keep the old access until the streaming watchdog catches up.
        await tx
          .update(flow)
          .set({ enabled: false, revision: sql`${flow.revision} + 1` })
          .where(flows);
        await tx
          .update(token)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(token.userId, owner.userId),
              eq(token.organizationId, owner.organizationId),
              isNull(token.revokedAt),
              isNull(token.oauthClientId),
              or(
                inArray(token.id, tx.select({ id: chat.executionTokenId }).from(chat).where(chats)),
                inArray(
                  token.id,
                  tx
                    .select({ id: run.tokenId })
                    .from(run)
                    .where(
                      and(
                        eq(run.userId, owner.userId),
                        eq(run.organizationId, owner.organizationId),
                        inArray(
                          run.automationId,
                          tx.select({ id: flow.id }).from(flow).where(flows),
                        ),
                      ),
                    ),
                ),
              ),
            ),
          );
        await tx
          .update(chat)
          .set({ stopRequested: true })
          .where(and(chats, inArray(chat.state, ["running", "waiting"])));
        return saved;
      });
    },
    tasks(owner: AssistantOwner, id: string) {
      return db
        .select()
        .from(chat)
        .where(
          and(
            eq(chat.userId, owner.userId),
            eq(chat.organizationId, owner.organizationId),
            eq(chat.agentId, id),
          ),
        )
        .orderBy(desc(chat.updatedAt))
        .limit(100);
    },
  };
}
