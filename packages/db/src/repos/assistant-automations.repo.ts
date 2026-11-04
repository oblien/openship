import { and, eq, desc, inArray, lt, gt, or, isNull, sql, ne } from "drizzle-orm";
import type { Database } from "../client";
import {
  assistantAutomation as rule,
  assistantAutomationRun as run,
  assistantAutomationSettings as settings,
} from "../schema/assistant-automations";
import { project } from "../schema/project";
import type { AssistantOwner } from "./assistant.repo";
import { AppError } from "@repo/core";

export type AssistantAutomationRow = typeof rule.$inferSelect;
export type AssistantAutomationRunRow = typeof run.$inferSelect;
const active = ["queued", "investigating", "approval", "applying", "verifying"];
const scope = (table: typeof rule | typeof run | typeof settings, owner: AssistantOwner) =>
  and(eq(table.userId, owner.userId), eq(table.organizationId, owner.organizationId));
export function createAssistantAutomationsRepo(db: Database) {
  return {
    enabled() {
      return db.select().from(rule).where(eq(rule.enabled, true));
    },
    async settings(owner: AssistantOwner) {
      return (await db.select().from(settings).where(scope(settings, owner)).limit(1))[0];
    },
    async pause(owner: AssistantOwner, paused: boolean) {
      await db.transaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(settings)
          .where(scope(settings, owner))
          .limit(1)
          .for("update");
        if (!paused && previous?.paused)
          await tx
            .update(rule)
            .set({ armedAt: new Date(), revision: sql`${rule.revision} + 1` })
            .where(scope(rule, owner));
        await tx
          .insert(settings)
          .values({ userId: owner.userId, organizationId: owner.organizationId, paused })
          .onConflictDoUpdate({
            target: [settings.userId, settings.organizationId],
            set: { paused },
          });
      });
    },
    list(owner: AssistantOwner) {
      return db.select().from(rule).where(scope(rule, owner)).orderBy(desc(rule.createdAt));
    },
    async find(owner: AssistantOwner, id: string) {
      return (
        await db
          .select()
          .from(rule)
          .where(and(scope(rule, owner), eq(rule.id, id)))
          .limit(1)
      )[0];
    },
    async save(input: typeof rule.$inferInsert, id?: string) {
      if (!id) return (await db.insert(rule).values(input).returning())[0]!;
      const { id: _, userId, organizationId, createdAt, ...data } = input;
      return (
        await db
          .update(rule)
          .set({ ...data, armedAt: new Date(), revision: sql`${rule.revision} + 1` })
          .where(and(scope(rule, { userId, organizationId }), eq(rule.id, id)))
          .returning()
      )[0];
    },
    /** All reviewed revisions must still match. A stale item rolls back the entire batch. */
    async activateReviewed(
      owner: AssistantOwner,
      inputs: Array<{
        revision: number;
        values: typeof rule.$inferInsert;
      }>,
    ) {
      return db.transaction(async (tx) => {
        const saved: AssistantAutomationRow[] = [];
        // Stable locking order prevents two overlapping reviews from deadlocking.
        for (const input of [...inputs].sort((a, b) => a.values.id.localeCompare(b.values.id))) {
          const { id, userId, organizationId, createdAt, ...values } = input.values;
          const [updated] = await tx
            .update(rule)
            .set({
              ...values,
              enabled: true,
              armedAt: new Date(),
              revision: sql`${rule.revision} + 1`,
            })
            .where(
              and(
                scope(rule, owner),
                eq(rule.id, id),
                eq(rule.revision, input.revision),
                eq(rule.enabled, false),
              ),
            )
            .returning();
          if (!updated)
            throw new AppError(
              "An automation changed since this review. Refresh the review before enabling it.",
              409,
              "ASSISTANT_AUTOMATION_REVIEW_CHANGED",
            );
          saved.push(updated);
        }
        return saved;
      });
    },
    async disable(owner: AssistantOwner, id: string) {
      await db
        .update(rule)
        .set({ enabled: false, revision: sql`${rule.revision} + 1` })
        .where(and(scope(rule, owner), eq(rule.id, id)));
    },
    candidates(organizationId: string, projectId: string, trigger: string) {
      return db
        .select()
        .from(rule)
        .where(
          and(
            eq(rule.organizationId, organizationId),
            eq(rule.projectId, projectId),
            eq(rule.trigger, trigger),
            eq(rule.enabled, true),
          ),
        );
    },
    async enqueue(input: typeof run.$inferInsert) {
      return (await db.insert(run).values(input).onConflictDoNothing().returning())[0];
    },
    runs(owner: AssistantOwner) {
      return db.select().from(run).where(scope(run, owner)).orderBy(desc(run.createdAt)).limit(100);
    },
    async cancelPending(owner: AssistantOwner, automationId?: string, beforeRevision?: number) {
      return db
        .update(run)
        .set({
          state: "cancelled",
          message: "Automation paused. No action was taken.",
          expiresAt: null,
          notifiedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            scope(run, owner),
            automationId ? eq(run.automationId, automationId) : undefined,
            beforeRevision === undefined ? undefined : lt(run.revision, beforeRevision),
            inArray(run.state, ["queued", "investigating", "approval"]),
            isNull(run.actionClaimedAt),
          ),
        )
        .returning();
    },
    async run(owner: AssistantOwner, id: string) {
      return (
        await db
          .select()
          .from(run)
          .where(and(scope(run, owner), eq(run.id, id)))
          .limit(1)
      )[0];
    },
    pending() {
      return db
        .select()
        .from(run)
        .where(
          and(
            or(isNull(run.leaseUntil), lt(run.leaseUntil, new Date())),
            or(
              inArray(
                run.state,
                active.filter((state) => state !== "approval"),
              ),
              and(eq(run.state, "approval"), lt(run.expiresAt, new Date())),
              isNull(run.notifiedAt),
            ),
          ),
        )
        .orderBy(run.updatedAt)
        .limit(50);
    },
    async lease(id: string, worker: string) {
      return (
        await db
          .update(run)
          .set({ leaseOwner: worker, leaseUntil: new Date(Date.now() + 120_000) })
          .where(and(eq(run.id, id), or(isNull(run.leaseUntil), lt(run.leaseUntil, new Date()))))
          .returning()
      )[0];
    },
    async release(id: string, worker: string) {
      await db
        .update(run)
        .set({ leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(run.id, id), eq(run.leaseOwner, worker)));
    },
    async update(
      owner: AssistantOwner,
      id: string,
      update: Partial<typeof run.$inferInsert>,
      states?: string[],
    ) {
      return (
        await db
          .update(run)
          .set({ ...update, updatedAt: new Date() })
          .where(
            and(scope(run, owner), eq(run.id, id), states ? inArray(run.state, states) : undefined),
          )
          .returning()
      )[0];
    },
    /** Bind credentials under the same rule lock used to pause or revise a flow. */
    async executionToken(
      receipt: AssistantAutomationRunRow,
      token: { tokenId: string; token: string },
    ) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(rule)
          .where(and(scope(rule, receipt), eq(rule.id, receipt.automationId)))
          .for("share");
        if (!current?.enabled || current.revision !== receipt.revision) return;
        return (
          await tx
            .update(run)
            .set({ ...token, updatedAt: new Date() })
            .where(and(scope(run, receipt), eq(run.id, receipt.id), eq(run.state, receipt.state)))
            .returning()
        )[0];
      });
    },
    /** Project lock serializes starts across rules and replicas; a receipt is never replayed. */
    async start(id: string) {
      return db.transaction(async (tx) => {
        const [pending] = await tx.select().from(run).where(eq(run.id, id)).limit(1);
        if (!pending) return;
        await tx
          .select({ id: project.id })
          .from(project)
          .where(
            and(
              eq(project.id, pending.projectId),
              eq(project.organizationId, pending.organizationId),
            ),
          )
          .for("update");
        const [current] = await tx
          .select()
          .from(rule)
          .where(eq(rule.id, pending.automationId))
          .for("update");
        const [receipt] = await tx.select().from(run).where(eq(run.id, id)).for("update");
        if (!current || receipt?.state !== "queued") return;
        const [prefs] = await tx.select().from(settings).where(scope(settings, current)).limit(1);
        const day = new Date(Date.now() - 86400000);
        const recent = await tx
          .select()
          .from(run)
          .where(
            and(
              eq(run.organizationId, current.organizationId),
              eq(run.projectId, current.projectId),
              ne(run.id, id),
              gt(run.createdAt, day),
            ),
          );
        let reason =
          !current.enabled || current.revision !== receipt.revision || prefs?.paused
            ? "Automation paused or changed before it started."
            : recent.some((r) =>
                  ["investigating", "approval", "applying", "verifying"].includes(r.state),
                )
              ? "An investigation is already active for this app."
              : current.lastStartedAt &&
                  current.lastStartedAt.getTime() > Date.now() - current.cooldownMinutes * 60000
                ? "Cooldown: this app was investigated recently."
                : recent.some(
                      (r) =>
                        r.actionClaimedAt && r.actionClaimedAt.getTime() > Date.now() - 10 * 60000,
                    )
                  ? "A recent automated action is still within its cooldown."
                  : recent.filter(
                        (r) =>
                          r.automationId === current.id &&
                          r.state !== "skipped" &&
                          r.state !== "queued",
                      ).length >= current.dailyLimit
                    ? "Daily investigation limit reached."
                    : null;
        if (reason) {
          await tx
            .update(run)
            .set({ state: "skipped", message: reason, updatedAt: new Date() })
            .where(eq(run.id, id));
          return;
        }
        await tx.update(rule).set({ lastStartedAt: new Date() }).where(eq(rule.id, current.id));
        return (
          await tx
            .update(run)
            .set({
              state: "investigating",
              expiresAt: new Date(Date.now() + 10 * 60000),
              updatedAt: new Date(),
            })
            .where(eq(run.id, id))
            .returning()
        )[0];
      });
    },
    /** The write boundary is claimed once, including across retries or lost responses. */
    async claimAction(owner: AssistantOwner, id: string, from: string, actionLease: string) {
      return (
        await db
          .update(run)
          .set({
            state: "applying",
            actionClaimedAt: new Date(),
            updatedAt: new Date(),
            notifiedAt: null,
            leaseOwner: actionLease,
            leaseUntil: new Date(Date.now() + 120_000),
          })
          .where(
            and(
              scope(run, owner),
              eq(run.id, id),
              eq(run.state, from),
              isNull(run.actionClaimedAt),
              gt(run.expiresAt, new Date()),
            ),
          )
          .returning()
      )[0];
    },
  };
}
