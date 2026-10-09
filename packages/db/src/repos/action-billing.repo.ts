import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
    ) {
      if (!Number.isSafeInteger(fundedUnits) || fundedUnits < 0)
        throw new Error("Invalid verified Actions credit grant");
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
            .set({ fundedUnits, status, checkedAt: new Date() })
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
