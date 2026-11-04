import { and, eq, desc, inArray, notInArray, lt, gt, or, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { assistantAgent as agent } from "../schema/assistant-agents";
import {
  assistantConnection as connection,
  assistantConversation as conversation,
  assistantRequest as receipt,
  assistantAuthorization as handshake,
} from "../schema/assistant";

export type AssistantRow = typeof conversation.$inferSelect;
export type AssistantConnectionRow = typeof connection.$inferSelect;
export type AssistantOwner = { userId: string; organizationId: string };
export function createAssistantRepo(db: Database) {
  const scope = (owner: AssistantOwner) =>
    and(
      eq(conversation.userId, owner.userId),
      eq(conversation.organizationId, owner.organizationId),
    );
  const owned = (owner: AssistantOwner, id: string) => and(scope(owner), eq(conversation.id, id));
  const connectionScope = (owner: AssistantOwner) =>
    and(eq(connection.userId, owner.userId), eq(connection.organizationId, owner.organizationId));
  return {
    async saveAuthorization(input: typeof handshake.$inferInsert) {
      await db.transaction(async (tx) => {
        await tx
          .delete(handshake)
          .where(
            or(
              lt(handshake.expiresAt, new Date()),
              and(
                eq(handshake.userId, input.userId),
                eq(handshake.organizationId, input.organizationId),
                eq(handshake.kind, input.kind),
              ),
            ),
          );
        await tx.insert(handshake).values(input);
      });
    },
    async authorization(id: string, consume = false) {
      const where = and(eq(handshake.id, id), gt(handshake.expiresAt, new Date()));
      return consume
        ? (await db.delete(handshake).where(where).returning())[0]
        : (await db.select().from(handshake).where(where).limit(1))[0];
    },
    async clearAuthorizations(owner: AssistantOwner) {
      await db
        .delete(handshake)
        .where(
          and(
            eq(handshake.userId, owner.userId),
            eq(handshake.organizationId, owner.organizationId),
          ),
        );
    },
    async connection(owner: AssistantOwner) {
      return (await db.select().from(connection).where(connectionScope(owner)).limit(1))[0];
    },
    async connect(input: typeof connection.$inferInsert) {
      await db
        .insert(connection)
        .values(input)
        .onConflictDoUpdate({
          target: [connection.userId, connection.organizationId],
          set: {
            clientId: input.clientId,
            origin: input.origin,
            serverId: input.serverId ?? null,
            createdAt: new Date(),
          },
        });
    },
    async disconnect(owner: AssistantOwner) {
      await db.delete(connection).where(connectionScope(owner));
    },
    list(owner: AssistantOwner) {
      return db
        .select()
        .from(conversation)
        .where(scope(owner))
        .orderBy(desc(conversation.updatedAt));
    },
    async find(owner: AssistantOwner, id: string) {
      return (await db.select().from(conversation).where(owned(owner, id)).limit(1))[0];
    },
    async create(input: typeof conversation.$inferInsert) {
      return (await db.insert(conversation).values(input).returning())[0]!;
    },
    async remove(owner: AssistantOwner, id: string) {
      await db.delete(conversation).where(owned(owner, id));
    },
    async request(owner: AssistantOwner, id: string, requestId: string) {
      return (
        await db
          .select({ receipt })
          .from(receipt)
          .innerJoin(conversation, eq(conversation.id, receipt.conversationId))
          .where(and(owned(owner, id), eq(receipt.id, requestId)))
          .limit(1)
      )[0]?.receipt;
    },
    /** Question acknowledgements share the receipt ledger, never the transcript. */
    async claimAnswer(owner: AssistantOwner, id: string, requestId: string, messageHash: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(conversation)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!row) return;
        await tx
          .insert(receipt)
          .values({ conversationId: id, id: requestId, messageHash })
          .onConflictDoNothing();
        return (
          await tx
            .select()
            .from(receipt)
            .where(and(eq(receipt.conversationId, id), eq(receipt.id, requestId)))
            .limit(1)
        )[0];
      });
    },
    async finishAnswer(
      owner: AssistantOwner,
      id: string,
      requestId: string,
      update: { runId?: string; state?: string },
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(conversation)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (row)
          await tx
            .update(receipt)
            .set(update)
            .where(and(eq(receipt.conversationId, id), eq(receipt.id, requestId)));
      });
    },
    async answered(owner: AssistantOwner, id: string, ids: string[]) {
      if (!ids.length) return new Set<string>();
      const rows = await db
        .select({ id: receipt.id })
        .from(receipt)
        .innerJoin(conversation, eq(conversation.id, receipt.conversationId))
        .where(and(owned(owner, id), inArray(receipt.id, ids), eq(receipt.state, "done")));
      return new Set(rows.map((row) => row.id));
    },
    async claim(
      owner: AssistantOwner,
      id: string,
      requestId: string,
      messageHash: string,
      title: string,
      runOwner: string,
      model?: string,
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(conversation)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!row || row.state === "running" || row.state === "waiting") return false;
        const inserted = await tx
          .insert(receipt)
          .values({ conversationId: id, id: requestId, messageHash })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length) return false;
        await tx
          .update(conversation)
          .set({
            state: "running",
            ...(model !== undefined ? { model } : {}),
            requestId,
            runId: null,
            runOwner,
            leaseExpiresAt: new Date(Date.now() + 30_000),
            stopRequested: false,
            updatedAt: new Date(),
            title: row.title === "New conversation" ? title.slice(0, 80) : row.title,
          })
          .where(owned(owner, id));
        return true;
      });
    },
    /** Only a dead lease may be recovered. A different API replica must not cancel live work. */
    async recover(owner: AssistantOwner, id: string, requestId: string, runOwner: string) {
      return (
        await db
          .update(conversation)
          .set({ runOwner, leaseExpiresAt: new Date(Date.now() + 30_000) })
          .where(
            and(
              owned(owner, id),
              eq(conversation.requestId, requestId),
              inArray(conversation.state, ["running", "waiting"]),
              or(isNull(conversation.leaseExpiresAt), lt(conversation.leaseExpiresAt, new Date())),
            ),
          )
          .returning()
      )[0];
    },
    async heartbeat(owner: AssistantOwner, id: string, requestId: string, runOwner: string) {
      return (
        await db
          .update(conversation)
          .set({ leaseExpiresAt: new Date(Date.now() + 30_000) })
          .where(
            and(
              owned(owner, id),
              eq(conversation.requestId, requestId),
              eq(conversation.runOwner, runOwner),
              inArray(conversation.state, ["running", "waiting"]),
            ),
          )
          .returning()
      )[0];
    },
    async requestStop(owner: AssistantOwner, id: string) {
      await db
        .update(conversation)
        .set({ stopRequested: true })
        .where(and(owned(owner, id), inArray(conversation.state, ["running", "waiting"])));
    },
    async executionToken(
      owner: AssistantOwner,
      id: string,
      token: { executionToken: string | null; executionTokenId: string | null },
    ) {
      return db.transaction(async (tx) => {
        const [chat] = await tx.select().from(conversation).where(owned(owner, id)).limit(1);
        if (!chat) return;
        if (chat.agentId) {
          // Serialize credential binding with policy edits. A token minted just
          // before a scope change must never be installed after that change.
          const [current] = await tx
            .select()
            .from(agent)
            .where(
              and(
                eq(agent.id, chat.agentId),
                eq(agent.userId, owner.userId),
                eq(agent.organizationId, owner.organizationId),
              ),
            )
            .for("share");
          if (!current || current.archived || current.revision !== chat.agentRevision) return;
        }
        return (await tx.update(conversation).set(token).where(owned(owner, id)).returning())[0];
      });
    },
    async clearExecutionToken(owner: AssistantOwner, id: string, tokenId: string) {
      return (
        await db
          .update(conversation)
          .set({ executionToken: null, executionTokenId: null })
          .where(and(owned(owner, id), eq(conversation.executionTokenId, tokenId)))
          .returning()
      )[0];
    },
    async progress(
      owner: AssistantOwner,
      id: string,
      requestId: string,
      update: { runId?: string; state?: string },
    ) {
      return db.transaction(async (tx) => {
        // A late stream or stop must never overwrite a newer turn or a terminal receipt.
        const [row] = await tx
          .update(conversation)
          .set({ ...update, updatedAt: new Date() })
          .where(
            and(
              owned(owner, id),
              eq(conversation.requestId, requestId),
              notInArray(conversation.state, ["done", "cancelled", "error"]),
            ),
          )
          .returning();
        if (row)
          await tx
            .update(receipt)
            .set(update)
            .where(and(eq(receipt.conversationId, id), eq(receipt.id, requestId)));
        return row;
      });
    },
  };
}
