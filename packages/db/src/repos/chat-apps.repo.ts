import { and, eq, desc, gt, lt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  chatAppConnection as connection,
  chatAppIdentity as identity,
  chatAppChallenge as challenge,
  chatAppCommand as command,
  chatAppThread as thread,
  chatAppTransportState as transport,
  chatAppInbox as inbox,
} from "../schema/chat-apps";
export type ChatAppConnection = typeof connection.$inferSelect;
export type ChatAppIdentity = typeof identity.$inferSelect;
export type ChatAppThread = typeof thread.$inferSelect;
export type ChatAppReceipt = typeof command.$inferSelect;
export function createChatAppsRepo(db: Database) {
  return {
    list(organizationId: string) {
      return db
        .select()
        .from(connection)
        .where(eq(connection.organizationId, organizationId))
        .orderBy(desc(connection.createdAt));
    },
    active() {
      return db.select().from(connection).where(eq(connection.enabled, true));
    },
    async get(id: string) {
      return (await db.select().from(connection).where(eq(connection.id, id)).limit(1))[0];
    },
    async create(input: typeof connection.$inferInsert) {
      return (await db.insert(connection).values(input).returning())[0]!;
    },
    async update(
      id: string,
      revision: number,
      input: Partial<
        Pick<
          ChatAppConnection,
          "name" | "nativeId" | "enabled" | "assistantAllowed" | "purpose" | "transport"
        >
      >,
    ) {
      return (
        await db
          .update(connection)
          .set({ ...input, revision: revision + 1 })
          .where(and(eq(connection.id, id), eq(connection.revision, revision)))
          .returning()
      )[0];
    },
    async remove(id: string) {
      await db.delete(connection).where(eq(connection.id, id));
    },
    async transport(id: string) {
      return (await db.select().from(transport).where(eq(transport.connectionId, id)))[0];
    },
    async saveTransport(id: string, configuration: string, botKey: string) {
      await db
        .insert(transport)
        .values({ connectionId: id, configuration, botKey })
        .onConflictDoUpdate({
          target: transport.connectionId,
          set: {
            configuration,
            botKey,
            cursor: sql`case when ${transport.botKey} = ${botKey} then ${transport.cursor} else null end`,
            owner: null,
            leaseUntil: null,
          },
        });
    },
    async acquireReceiver(id: string, revision: number, owner: string) {
      return (
        await db
          .update(transport)
          .set({ owner, leaseUntil: sql`now() + interval '30 seconds'` })
          .where(
            and(
              eq(transport.connectionId, id),
              or(
                eq(transport.owner, owner),
                isNull(transport.leaseUntil),
                lt(transport.leaseUntil, sql`now()`),
              ),
              sql`exists (select 1 from ${connection} where ${connection.id} = ${id} and ${connection.revision} = ${revision} and ${connection.enabled} = true)`,
            ),
          )
          .returning()
      )[0];
    },
    async releaseReceiver(id: string, owner: string) {
      await db
        .update(transport)
        .set({ owner: null, leaseUntil: null })
        .where(and(eq(transport.connectionId, id), eq(transport.owner, owner)));
    },
    async saveReceiverCursor(id: string, owner: string, cursor: string) {
      return (
        await db
          .update(transport)
          .set({ cursor })
          .where(
            and(
              eq(transport.connectionId, id),
              eq(transport.owner, owner),
              gt(transport.leaseUntil, sql`now()`),
            ),
          )
          .returning()
      )[0];
    },
    /** Shares the connection row lock with pause/reconfigure. A stale receiver cannot enqueue. */
    async enqueue(
      c: Pick<ChatAppConnection, "id" | "revision">,
      owner: string | null,
      event: { id: string; payload: string; state: string },
    ) {
      return db.transaction(async (tx) => {
        const active = (
          await tx
            .select()
            .from(connection)
            .where(
              and(
                eq(connection.id, c.id),
                eq(connection.revision, c.revision),
                eq(connection.enabled, true),
              ),
            )
            .for("update")
        )[0];
        if (!active) return false;
        if (
          owner &&
          !(
            await tx
              .select()
              .from(transport)
              .where(
                and(
                  eq(transport.connectionId, c.id),
                  eq(transport.owner, owner),
                  gt(transport.leaseUntil, sql`now()`),
                ),
              )
              .for("share")
          )[0]
        )
          return false;
        const existing = (
          await tx.select({ id: inbox.id }).from(inbox).where(eq(inbox.id, event.id))
        )[0];
        if (existing) return true;
        const [queued] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(inbox)
          .where(
            and(
              eq(inbox.connectionId, c.id),
              or(
                eq(inbox.state, "pending"),
                eq(inbox.state, "awaiting_ack"),
                eq(inbox.state, "claimed"),
              ),
            ),
          );
        if (queued!.count >= 1000) throw new Error("Chat inbox capacity reached");
        await tx
          .insert(inbox)
          .values({ ...event, connectionId: c.id, revision: c.revision })
          .onConflictDoNothing();
        return true;
      });
    },
    async acknowledgeInbox(connectionId: string, id: string, revision: number) {
      await db
        .update(inbox)
        .set({ state: "pending" })
        .where(
          and(
            eq(inbox.id, id),
            eq(inbox.connectionId, connectionId),
            eq(inbox.revision, revision),
            eq(inbox.state, "awaiting_ack"),
          ),
        );
    },
    async claimInbox(id: string, revision: number, lease: string) {
      return db.transaction(async (tx) => {
        const next = (
          await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.connectionId, id),
                eq(inbox.revision, revision),
                or(
                  eq(inbox.state, "pending"),
                  and(eq(inbox.state, "claimed"), lt(inbox.leaseUntil, sql`now()`)),
                ),
              ),
            )
            .orderBy(inbox.createdAt)
            .limit(1)
            .for("update", { skipLocked: true })
        )[0];
        if (!next) return undefined;
        return (
          await tx
            .update(inbox)
            .set({ state: "claimed", lease, leaseUntil: sql`now() + interval '90 seconds'` })
            .where(eq(inbox.id, next.id))
            .returning()
        )[0];
      });
    },
    async beginDelivery(connectionId: string, id: string, revision: number, lease: string) {
      return (
        await db
          .update(inbox)
          .set({ state: "sending" })
          .where(
            and(
              eq(inbox.id, id),
              eq(inbox.connectionId, connectionId),
              eq(inbox.revision, revision),
              eq(inbox.state, "claimed"),
              eq(inbox.lease, lease),
              gt(inbox.leaseUntil, sql`now()`),
            ),
          )
          .returning()
      )[0];
    },
    async delivered(id: string, lease: string, index: number, final: boolean) {
      return (await db.update(inbox)
        .set({ state: final ? "done" : "claimed", deliveredCount: index + 1,
          ...(final ? { payload: "", lease: null, leaseUntil: null } : {}) })
        .where(and(eq(inbox.id, id), eq(inbox.lease, lease), eq(inbox.state, "sending"), eq(inbox.deliveredCount, index)))
        .returning())[0];
    },
    async inboxEvent(id: string) {
      return (await db.select().from(inbox).where(eq(inbox.id, id)))[0];
    },
    identities(connectionId: string) {
      return db.select().from(identity).where(eq(identity.connectionId, connectionId));
    },
    async identity(connectionId: string, workspace: string, sender: string) {
      return (
        await db
          .select()
          .from(identity)
          .where(
            and(
              eq(identity.connectionId, connectionId),
              eq(identity.externalWorkspace, workspace),
              eq(identity.externalUser, sender),
            ),
          )
          .limit(1)
      )[0];
    },
    async link(input: typeof identity.$inferInsert) {
      return (await db.insert(identity).values(input).onConflictDoNothing().returning())[0];
    },
    async identityById(id: string) {
      return (await db.select().from(identity).where(eq(identity.id, id)).limit(1))[0];
    },
    async configureAssistant(
      id: string,
      userId: string,
      revision: number,
      input: Pick<
        ChatAppIdentity,
        "assistantProvider" | "assistantModel" | "assistantAuthority" | "assistantFingerprint"
      >,
    ) {
      return (
        await db
          .update(identity)
          .set({ ...input, assistantRevision: revision + 1 })
          .where(
            and(
              eq(identity.id, id),
              eq(identity.userId, userId),
              eq(identity.assistantRevision, revision),
            ),
          )
          .returning()
      )[0];
    },
    async thread(id: string) {
      return (await db.select().from(thread).where(eq(thread.id, id)).limit(1))[0];
    },
    threads(identityId: string, senderKey: string) {
      return db
        .select()
        .from(thread)
        .where(and(eq(thread.identityId, identityId), eq(thread.senderKey, senderKey)));
    },
    async activeThread(identityId: string, senderKey: string) {
      return (
        await db
          .select()
          .from(thread)
          .where(
            and(
              eq(thread.identityId, identityId),
              eq(thread.senderKey, senderKey),
              eq(thread.active, true),
            ),
          )
          .limit(1)
      )[0];
    },
    /** Caller holds the sender lock. History bindings are immutable; only selection changes. */
    async saveThread(input: typeof thread.$inferInsert) {
      return db.transaction(async (tx) => {
        await tx
          .update(thread)
          .set({ active: false })
          .where(
            and(eq(thread.identityId, input.identityId), eq(thread.senderKey, input.senderKey)),
          );
        return (await tx.insert(thread).values(input).returning())[0]!;
      });
    },
    async selectThread(input: ChatAppThread) {
      return db.transaction(async (tx) => {
        await tx
          .update(thread)
          .set({ active: false })
          .where(
            and(eq(thread.identityId, input.identityId), eq(thread.senderKey, input.senderKey)),
          );
        return (
          await tx.update(thread).set({ active: true }).where(eq(thread.id, input.id)).returning()
        )[0];
      });
    },
    async deactivateThread(id: string) {
      await db.update(thread).set({ active: false }).where(eq(thread.id, id));
    },
    async removeThread(id: string) {
      await db.delete(thread).where(eq(thread.id, id));
    },
    async unlink(id: string, userId: string) {
      return (
        await db
          .delete(identity)
          .where(and(eq(identity.id, id), eq(identity.userId, userId)))
          .returning()
      )[0];
    },
    async challenge(input: typeof challenge.$inferInsert) {
      await db.insert(challenge).values(input);
    },
    async readChallenge(id: string, consume = false) {
      const where = and(eq(challenge.id, id), gt(challenge.expiresAt, new Date()));
      return consume
        ? (await db.delete(challenge).where(where).returning())[0]
        : (await db.select().from(challenge).where(where).limit(1))[0];
    },
    async claimCommand(input: typeof command.$inferInsert) {
      return (await db.insert(command).values(input).onConflictDoNothing().returning())[0];
    },
    async command(id: string) {
      return (await db.select().from(command).where(eq(command.id, id)).limit(1))[0];
    },
    async finishCommand(id: string, response: string) {
      await db.update(command).set({ state: "done", response }).where(eq(command.id, id));
    },
    async bindConversation(
      id: string,
      conversationId: string,
      assistantRequestId: string,
      delivery: string,
    ) {
      await db
        .update(command)
        .set({ conversationId, assistantRequestId, delivery })
        .where(eq(command.id, id));
    },
    async updateDelivery(id: string, delivery: string | null) {
      await db.update(command).set({ delivery }).where(eq(command.id, id));
    },
    pendingReplies(connectionId: string) {
      return db
        .select()
        .from(command)
        .where(and(eq(command.connectionId, connectionId), isNotNull(command.delivery)))
        .orderBy(command.createdAt)
        .limit(20);
    },
    events(connectionId: string) {
      return db
        .select({
          id: command.id,
          externalUser: command.externalUser,
          command: command.command,
          state: command.state,
          createdAt: command.createdAt,
        })
        .from(command)
        .where(eq(command.connectionId, connectionId))
        .orderBy(desc(command.createdAt))
        .limit(50);
    },
    async prune() {
      await db.delete(inbox).where(lt(inbox.createdAt, new Date(Date.now() - 7 * 86400000)));
      await db.delete(challenge).where(lt(challenge.expiresAt, new Date()));
      await db.delete(command).where(lt(command.createdAt, new Date(Date.now() - 30 * 86400000)));
    },
  };
}
