import { and, eq, inArray, isNull, lt, lte, asc, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  cloudAnalyticsEvent as events,
  cloudAnalyticsCheckout as checkouts,
  cloudAnalyticsWorkspace as workspaces,
} from "../schema/cloud-analytics";

export type CloudAnalyticsOutboxInput = typeof events.$inferInsert;
export type CloudAnalyticsOutboxEvent = typeof events.$inferSelect;
export type CloudAnalyticsCheckout = typeof checkouts.$inferSelect;

export function createCloudAnalyticsRepo(db: Database) {
  return {
    async enqueue(input: CloudAnalyticsOutboxInput) {
      await db.insert(events).values(input).onConflictDoNothing();
    },
    async findEvent(organizationId: string, id: string) {
      return (
        (
          await db
            .select()
            .from(events)
            .where(and(eq(events.organizationId, organizationId), eq(events.id, id)))
            .limit(1)
        )[0] ?? null
      );
    },
    async claim(leaseId: string, now: Date, limit = 100) {
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(isNull(events.deliveredAt), lte(events.nextAttemptAt, now)))
          .orderBy(asc(events.nextAttemptAt), asc(events.id))
          .limit(limit)
          .for("update", { skipLocked: true });
        if (!due.length) return [];
        return tx
          .update(events)
          .set({
            leaseId,
            attempts: sql`${events.attempts} + 1`,
            nextAttemptAt: new Date(now.getTime() + 60_000),
          })
          .where(
            inArray(
              events.id,
              due.map((row) => row.id),
            ),
          )
          .returning();
      });
    },
    async acknowledge(ids: string[], leaseId: string, now: Date) {
      if (ids.length)
        await db
          .update(events)
          .set({ deliveredAt: now, leaseId: null })
          .where(and(inArray(events.id, ids), eq(events.leaseId, leaseId)));
    },
    async retry(ids: string[], leaseId: string, nextAttemptAt: Date) {
      if (ids.length)
        await db
          .update(events)
          .set({ nextAttemptAt, leaseId: null })
          .where(and(inArray(events.id, ids), eq(events.leaseId, leaseId)));
    },
    async prune(before: Date) {
      // Never discard undelivered records or retained financial/milestone receipts.
      await db.delete(events).where(and(eq(events.retain, false), lt(events.deliveredAt, before)));
    },
    async rememberCheckout(
      input: Pick<CloudAnalyticsCheckout, "id" | "organizationId" | "userId" | "kind">,
      event: CloudAnalyticsOutboxInput,
    ) {
      await db.transaction(async (tx) => {
        // A retry by a teammate must not replace the original payer attribution.
        await tx.insert(checkouts).values(input).onConflictDoNothing();
        const [saved] = await tx
          .select()
          .from(checkouts)
          .where(
            and(eq(checkouts.id, input.id), eq(checkouts.organizationId, input.organizationId)),
          );
        if (saved)
          await tx
            .insert(events)
            .values({ ...event, distinctId: saved.userId })
            .onConflictDoNothing();
      });
    },
    async findCheckout(organizationId: string, id: string) {
      return (
        (
          await db
            .select()
            .from(checkouts)
            .where(and(eq(checkouts.id, id), eq(checkouts.organizationId, organizationId)))
            .limit(1)
        )[0] ?? null
      );
    },
    async recheckCheckout(organizationId: string, id: string) {
      await db
        .update(checkouts)
        .set({ nextCheckAt: new Date(), checks: 0 })
        .where(and(eq(checkouts.id, id), eq(checkouts.organizationId, organizationId)));
    },
    async claimCheckouts(now: Date, limit = 20) {
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: checkouts.id })
          .from(checkouts)
          .where(lte(checkouts.nextCheckAt, now))
          .orderBy(asc(checkouts.nextCheckAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        if (!due.length) return [];
        return tx
          .update(checkouts)
          .set({
            checks: sql`${checkouts.checks} + 1`,
            nextCheckAt: new Date(now.getTime() + 30 * 60_000),
          })
          .where(
            inArray(
              checkouts.id,
              due.map((row) => row.id),
            ),
          )
          .returning();
      });
    },
    async observedCheckout(
      organizationId: string,
      id: string,
      status: string,
      nextCheckAt: Date | null,
    ) {
      await db
        .update(checkouts)
        .set({ status, nextCheckAt })
        .where(and(eq(checkouts.id, id), eq(checkouts.organizationId, organizationId)));
    },
    async snapshot(
      organizationId: string,
      state: Record<string, unknown>,
      build: (revision: number) => CloudAnalyticsOutboxInput[],
    ) {
      await db.transaction(async (tx) => {
        await tx.insert(workspaces).values({ organizationId }).onConflictDoNothing();
        const [current] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.organizationId, organizationId))
          .for("update");
        // jsonb may reorder keys, so compare canonical PostgreSQL values.
        const changed = await tx
          .update(workspaces)
          .set({ state, revision: current!.revision + 1 })
          .where(
            and(
              eq(workspaces.organizationId, organizationId),
              sql`${workspaces.state} IS DISTINCT FROM ${JSON.stringify(state)}::jsonb`,
            ),
          )
          .returning();
        if (changed[0])
          await tx.insert(events).values(build(changed[0].revision)).onConflictDoNothing();
      });
    },
  };
}
export type CloudAnalyticsRepo = ReturnType<typeof createCloudAnalyticsRepo>;
