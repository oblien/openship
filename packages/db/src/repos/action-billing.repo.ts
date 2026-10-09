import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  AppError,
  actionAffordableSeconds,
  actionDepositUnits,
  actionExecutionUnits,
  actionFinished,
  type ActionRunnerPrice,
} from "@repo/core";
import type { Database } from "../factory";
import { actionBudget, actionCharge, actionCreditPurchase } from "../schema/action-billing";
import { actionJob, actionRun } from "../schema/actions";
import { oblienWebhookEvent } from "../schema/billing";

/** IDs come from a signature-verified event. Its amounts are deliberately absent:
 * only a fresh checkout receipt can change the ledger. */
export interface ActionPaymentEvent {
  eventId: string;
  eventType: string;
  checkoutId?: string;
  purchaseId?: string;
}

type PurchaseInput = Pick<
  typeof actionCreditPurchase.$inferInsert,
  "id" | "organizationId" | "idempotencyKey" | "priceCents" | "request"
>;
const purchaseWhere = (org: string, id: string) =>
  and(eq(actionCreditPurchase.organizationId, org), eq(actionCreditPurchase.id, id));

export function createActionBillingRepo(db: Database) {
  return {
    async budget(org: string) {
      return (
        await db.select().from(actionBudget).where(eq(actionBudget.organizationId, org)).limit(1)
      )[0];
    },
    async byNamespace(namespace: string) {
      return (
        await db.select().from(actionBudget).where(eq(actionBudget.namespace, namespace)).limit(1)
      )[0];
    },
    async purchase(org: string, id: string) {
      return (
        await db.select().from(actionCreditPurchase).where(purchaseWhere(org, id)).limit(1)
      )[0];
    },
    async purchases(org: string, limit = 30) {
      return db
        .select()
        .from(actionCreditPurchase)
        .where(eq(actionCreditPurchase.organizationId, org))
        .orderBy(desc(actionCreditPurchase.createdAt))
        .limit(Math.min(100, limit));
    },
    async duePurchases(limit = 20) {
      return db
        .select({
          id: actionCreditPurchase.id,
          organizationId: actionCreditPurchase.organizationId,
        })
        .from(actionCreditPurchase)
        .where(lte(actionCreditPurchase.nextCheckAt, sql`now()`))
        .orderBy(asc(actionCreditPurchase.nextCheckAt), asc(actionCreditPurchase.id))
        .limit(Math.max(1, Math.min(100, limit)));
    },
    /** Called under the same organization lock as receipt reconciliation. Move
     * the deadline BEFORE provider I/O so a crash leaves a retry, not a hot loop.
     * The conditional update also rejects a stale sweep from another replica. */
    async beginPurchaseCheck(org: string, id: string) {
      return (
        await db
          .update(actionCreditPurchase)
          .set({
            checkAttempts: sql`LEAST(10, ${actionCreditPurchase.checkAttempts} + 1)`,
            nextCheckAt: sql`now() + LEAST(300, 30 * power(2, ${actionCreditPurchase.checkAttempts})) * interval '1 second'`,
          })
          .where(and(purchaseWhere(org, id), lte(actionCreditPurchase.nextCheckAt, sql`now()`)))
          .returning()
      )[0];
    },
    /** Queue and acknowledge together. The service's organization lock prevents
     * a receipt read in flight from overwriting a newer event's requested check. */
    async queuePurchaseChecks(org: string, event: ActionPaymentEvent) {
      return db.transaction(async (tx) => {
        const [accepted] = await tx
          .insert(oblienWebhookEvent)
          .values({
            oblienEventId: event.eventId,
            eventType: event.eventType,
            processedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: oblienWebhookEvent.oblienEventId,
            set: { processedAt: new Date() },
            setWhere: isNull(oblienWebhookEvent.processedAt),
          })
          .returning();
        if (!accepted) return false;

        let id: string | undefined;
        if (event.purchaseId || event.checkoutId) {
          const [purchase] = await tx
            .select({ id: actionCreditPurchase.id, checkoutId: actionCreditPurchase.checkoutId })
            .from(actionCreditPurchase)
            .where(
              and(
                eq(actionCreditPurchase.organizationId, org),
                event.purchaseId
                  ? eq(actionCreditPurchase.id, event.purchaseId)
                  : eq(actionCreditPurchase.checkoutId, event.checkoutId!),
              ),
            )
            .limit(1);
          // A provider payment not opened by this organization is not an order.
          if (!purchase) return false;
          if (purchase.checkoutId && event.checkoutId && purchase.checkoutId !== event.checkoutId)
            throw new Error("Actions payment event does not match the saved checkout");
          id = purchase.id;
        }
        await tx
          .update(actionCreditPurchase)
          .set({ nextCheckAt: sql`now()` })
          .where(
            and(
              eq(actionCreditPurchase.organizationId, org),
              id ? eq(actionCreditPurchase.id, id) : undefined,
            ),
          );
        return true;
      });
    },
    async createPurchase(input: PurchaseInput, namespace: string) {
      actionDepositUnits(input.priceCents);
      return db.transaction(async (tx) => {
        await tx
          .insert(actionBudget)
          .values({ organizationId: input.organizationId, namespace })
          .onConflictDoNothing();
        const [budget] = await tx
          .select()
          .from(actionBudget)
          .where(eq(actionBudget.organizationId, input.organizationId))
          .for("update");
        if (!budget || budget.namespace !== namespace)
          throw new Error("Actions funding namespace changed");
        const [prior] = await tx
          .select()
          .from(actionCreditPurchase)
          .where(
            and(
              eq(actionCreditPurchase.organizationId, input.organizationId),
              eq(actionCreditPurchase.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (prior) {
          if (prior.priceCents !== input.priceCents)
            throw new AppError(
              "This payment attempt already has a different amount. Resume it or start a new payment.",
              409,
              "ACTIONS_CHECKOUT_CONFLICT",
            );
          return prior;
        }
        const pending = await tx
          .select({ id: actionCreditPurchase.id })
          .from(actionCreditPurchase)
          .where(
            and(
              eq(actionCreditPurchase.organizationId, input.organizationId),
              inArray(actionCreditPurchase.status, ["pending", "open"]),
            ),
          )
          .limit(20);
        if (pending.length >= 20)
          throw new AppError(
            "Too many unfinished Actions payments. Resume an existing payment before opening another.",
            429,
            "ACTIONS_CHECKOUT_LIMIT",
          );
        return (await tx.insert(actionCreditPurchase).values(input).returning())[0]!;
      });
    },
    async recordCheckout(org: string, id: string, checkoutId: string, checkoutUrlEnc: string) {
      const [row] = await db
        .update(actionCreditPurchase)
        .set({ checkoutId, checkoutUrlEnc })
        .where(
          and(
            purchaseWhere(org, id),
            sql`(${actionCreditPurchase.checkoutId} IS NULL OR ${actionCreditPurchase.checkoutId} = ${checkoutId})`,
          ),
        )
        .returning();
      if (!row) throw new Error("Actions checkout identity changed");
      return row;
    },
    /** Apply an absolute NET receipt after the billing service serializes the
     * provider read under its advisory lock. Duplicate delivery cannot credit
     * twice; refunds can put spendable balance below zero. */
    async reconcilePurchase(
      org: string,
      id: string,
      checkoutId: string,
      fundedUnits: number,
      status: string,
      recheckAfterSeconds: number | null,
    ) {
      if (!Number.isSafeInteger(fundedUnits) || fundedUnits < 0)
        throw new Error("Invalid verified Actions credit grant");
      if (
        recheckAfterSeconds !== null &&
        (!Number.isSafeInteger(recheckAfterSeconds) ||
          recheckAfterSeconds < 1 ||
          recheckAfterSeconds > 86_400)
      )
        throw new Error("Invalid Actions payment check interval");
      return db.transaction(async (tx) => {
        const [budget] = await tx
          .select()
          .from(actionBudget)
          .where(eq(actionBudget.organizationId, org))
          .for("update");
        const [purchase] = await tx
          .select()
          .from(actionCreditPurchase)
          .where(purchaseWhere(org, id))
          .for("update");
        if (
          !budget ||
          !purchase ||
          purchase.checkoutId !== checkoutId ||
          fundedUnits > actionDepositUnits(purchase.priceCents)
        )
          throw new Error("Actions payment does not match the saved order");
        const total = budget.fundedUnits + fundedUnits - purchase.fundedUnits;
        if (!Number.isSafeInteger(total) || total < 0)
          throw new Error("Actions funding exceeds the supported balance");
        await tx
          .update(actionBudget)
          .set({ fundedUnits: total, updatedAt: new Date() })
          .where(eq(actionBudget.organizationId, org));
        return (
          await tx
            .update(actionCreditPurchase)
            .set({
              fundedUnits,
              status,
              checkedAt: new Date(),
              checkAttempts: 0,
              nextCheckAt:
                recheckAfterSeconds === null
                  ? null
                  : sql`now() + ${recheckAfterSeconds} * interval '1 second'`,
            })
            .where(purchaseWhere(org, id))
            .returning()
        )[0]!;
      });
    },
    async charge(org: string, jobId: string) {
      return (
        await db
          .select()
          .from(actionCharge)
          .where(and(eq(actionCharge.organizationId, org), eq(actionCharge.jobId, jobId)))
          .limit(1)
      )[0];
    },
    /** Reserve a bounded maximum before provisioning; sibling jobs cannot spend
     * the same funds. A saved reservation always retains its original tariff. */
    async reserve(
      org: string,
      jobId: string,
      leaseOwner: string,
      rate: ActionRunnerPrice,
      priceVersion: number,
    ) {
      return db.transaction(async (tx) => {
        const [budget] = await tx
          .select()
          .from(actionBudget)
          .where(eq(actionBudget.organizationId, org))
          .for("update");
        if (!budget)
          throw new AppError(
            "Add funds to your Actions budget before using a temporary Cloud runner.",
            402,
            "ACTIONS_CREDITS_REQUIRED",
          );
        const [job] = await tx
          .select()
          .from(actionJob)
          .where(
            and(
              eq(actionJob.organizationId, org),
              eq(actionJob.id, jobId),
              isNull(actionJob.finishedAt),
              isNull(actionJob.cancelRequestedAt),
              sql`EXISTS (SELECT 1 FROM ${actionRun} WHERE ${actionRun.id} = ${actionJob.runId} AND ${actionRun.leaseOwner} = ${leaseOwner} AND ${actionRun.leaseUntil} > now() AND ${actionRun.cancelRequestedAt} IS NULL)`,
            ),
          );
        if (!job?.spec) return null;
        const [prior] = await tx
          .select()
          .from(actionCharge)
          .where(and(eq(actionCharge.organizationId, org), eq(actionCharge.jobId, jobId)));
        if (prior) return prior;
        const available = Math.max(
          0,
          budget.fundedUnits - budget.spentUnits - budget.reservedUnits,
        );
        const seconds = actionAffordableSeconds(rate, available, job.spec.timeoutSeconds);
        if (seconds < Math.min(60, job.spec.timeoutSeconds))
          throw new AppError(
            "Your Actions budget is fully used or reserved by other jobs. Add funds or wait for those jobs to finish.",
            402,
            "ACTIONS_CREDITS_REQUIRED",
          );
        const reservedUnits = actionExecutionUnits(rate, seconds);
        await tx
          .update(actionBudget)
          .set({ reservedUnits: budget.reservedUnits + reservedUnits, updatedAt: new Date() })
          .where(eq(actionBudget.organizationId, org));
        return (
          await tx
            .insert(actionCharge)
            .values({
              jobId,
              organizationId: org,
              runnerPriceId: rate.id,
              priceVersion,
              microUsdPerMinute: rate.microUsdPerMinute,
              reservedSeconds: seconds,
              reservedUnits,
            })
            .returning()
        )[0]!;
      });
    },
    /** Must run after worker cleanup is confirmed. A provisioning failure has
     * zero execution seconds. The rest of its reserved amount is released. */
    async settle(org: string, jobId: string, seconds: number) {
      return db.transaction(async (tx) => {
        const [budget] = await tx
          .select()
          .from(actionBudget)
          .where(eq(actionBudget.organizationId, org))
          .for("update");
        const [charge] = await tx
          .select()
          .from(actionCharge)
          .where(and(eq(actionCharge.organizationId, org), eq(actionCharge.jobId, jobId)))
          .for("update");
        if (!budget || !charge || charge.settledAt) return charge;
        const [job] = await tx
          .select()
          .from(actionJob)
          .where(and(eq(actionJob.organizationId, org), eq(actionJob.id, jobId)));
        if (!job?.cleanedAt || !actionFinished(job.status))
          throw new Error("Actions worker cleanup must finish before settling its reservation");
        if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > charge.reservedSeconds)
          throw new Error("Execution time exceeds the Actions reservation");
        const chargedUnits = actionExecutionUnits(charge, seconds);
        await tx
          .update(actionBudget)
          .set({
            spentUnits: budget.spentUnits + chargedUnits,
            reservedUnits: budget.reservedUnits - charge.reservedUnits,
            updatedAt: new Date(),
          })
          .where(eq(actionBudget.organizationId, org));
        return (
          await tx
            .update(actionCharge)
            .set({ chargedSeconds: seconds, chargedUnits, settledAt: new Date() })
            .where(eq(actionCharge.jobId, jobId))
            .returning()
        )[0]!;
      });
    },
  };
}
