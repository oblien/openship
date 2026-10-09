import {
  ACTIONS_UNITS_PER_CENT,
  actionCreditUnits,
  AppError,
  PRICING,
  tryWithKeyedMutex,
} from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import type { ActionBudget, ActionCreditPurchase } from "@repo/contracts";
import { repos } from "@repo/db";
import type { Repositories } from "@repo/db/factory";
import type { ExecutionContext } from "../../../context";
import { env, localDashboardUrl } from "../../config/env";
import { encrypt, decrypt } from "../../lib/encryption";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { createProvisionLock } from "../../lib/provision-lock";
import { ActionCredits, actionBillingNamespace } from "./billing";
import { ensureActionsBillingNamespace, ensureFundedActionRunners } from "./billing-namespace";

const purchasesConfigured = () =>
  env.BILLING_ENABLED && !!env.OBLIEN_CLIENT_ID && !!env.OBLIEN_CLIENT_SECRET;

function requireCloud() {
  if (!env.CLOUD_MODE)
    throw new AppError(
      "Actions funding is managed by Openship Cloud",
      409,
      "ACTIONS_BILLING_CLOUD_ONLY",
    );
}

async function requirePurchases() {
  requireCloud();
  if (!purchasesConfigured())
    throw new AppError(
      "Cloud Actions payments are temporarily unavailable. You can still use a connected server.",
      503,
      "ACTIONS_CHECKOUT_UNAVAILABLE",
    );
  // Check the live conversion before opening a new checkout. No preview tariff
  // or hardcoded execution-minute price can silently substitute for the meter.
  await getOblienBillingApi().getMeteredPricing();
}

function credits() {
  return new ActionCredits({
    repo: repos.actionBilling,
    provider: {
      createCheckout: (request) => getOblienBillingApi().createCheckout(request),
      getCheckout: (namespace, checkoutId) =>
        getOblienBillingApi().getCheckout(namespace, checkoutId),
    },
    prepareNamespace: ensureActionsBillingNamespace,
    prepareRunners: ensureFundedActionRunners,
    lock: (org, work) => createProvisionLock(`actions-billing:${org}`).run(work),
    encrypt,
    decrypt,
    dashboardUrl: localDashboardUrl,
  });
}

export async function queueActionsPaymentCheck(
  organizationId: string,
  event: Parameters<ActionCredits["queuePaymentCheck"]>[1],
) {
  requireCloud();
  return credits().queuePaymentCheck(organizationId, event);
}

/** Separate from the workflow controller: provider outages must not delay run
 * observation or cancellation. The purchase rows are the durable queue. */
export async function runActionsPaymentReconcile() {
  const stats = { scanned: 0, checked: 0, errors: 0 };
  if (!env.CLOUD_MODE) return stats;
  return (
    (await tryWithKeyedMutex("actions-payment-reconcile", async () => {
      const pending = await repos.actionBilling.duePurchases(20);
      const service = credits();
      for (let start = 0; start < pending.length; start += 4) {
        const batch = pending.slice(start, start + 4);
        const results = await Promise.allSettled(
          batch.map((purchase) => service.recoverDuePurchase(purchase.organizationId, purchase.id)),
        );
        stats.scanned += batch.length;
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") {
            if (result.value) stats.checked++;
          } else {
            stats.errors++;
            diagnostics.warn(
              "platform/engine/modules/actions/billing-application",
              `Actions payment check failed for ${batch[index]!.id}`,
              result.reason,
            );
          }
        }
      }
      return stats;
    })) ?? stats
  );
}

type Purchase = NonNullable<Awaited<ReturnType<Repositories["actionBilling"]["purchase"]>>>;
function presentPurchase(purchase: Purchase): ActionCreditPurchase {
  // Deliberately omit the namespace, provider request and credential-bearing URL.
  return {
    id: purchase.id,
    priceCents: purchase.priceCents,
    fundedUnits: purchase.fundedUnits,
    status: purchase.status,
    createdAt: purchase.createdAt.toISOString(),
    checkedAt: purchase.checkedAt?.toISOString() ?? null,
  };
}

export async function getActionsBudget(ctx: ExecutionContext): Promise<ActionBudget> {
  requireCloud();
  const [budget, purchases] = await Promise.all([
    repos.actionBilling.budget(ctx.organizationId),
    repos.actionBilling.purchases(ctx.organizationId),
  ]);
  const pricing: ActionBudget["pricing"] = {
    version: PRICING.actions.version,
    maxParallel: PRICING.actions.maxParallel,
    depositsCents: [...PRICING.actions.depositsCents],
    runners: PRICING.actions.runners.map((runner) => ({
      ...runner,
      estimatedUnitsPerMinute: null,
    })),
    meter: null,
  };
  const balance: ActionBudget["balance"] = {
    fundedUnits: budget?.fundedUnits ?? 0,
    spentUnits: budget ? null : 0,
    availableUnits: budget ? null : 0,
    blocking: true,
    status: budget ? "unavailable" : "unfunded",
    checkedAt: null,
  };
  await Promise.all([
    (async () => {
      try {
        const { rates, rate_card_id } = await getOblienBillingApi().getMeteredPricing();
        const runners = PRICING.actions.runners.map((runner) => ({
          ...runner,
          estimatedUnitsPerMinute: actionCreditUnits(
            runner.cpuCores * rates.cpu_per_min +
              (runner.memoryMb / 1024) * rates.memory_per_gb_min,
          ),
        }));
        pricing.meter = {
          rateCardId: rate_card_id,
          cpuUnitsPerMinute: actionCreditUnits(rates.cpu_per_min),
          memoryUnitsPerGiBMinute: actionCreditUnits(rates.memory_per_gb_min),
          networkUnitsPerGb: actionCreditUnits(rates.network_per_gb),
          diskUnitsPerGb: actionCreditUnits(rates.disk_per_gb),
        };
        pricing.runners = runners;
      } catch (error) {
        diagnostics.warn(
          "platform/engine/modules/actions/billing-application",
          "Actions pricing is unavailable",
          error,
        );
      }
    })(),
    (async () => {
      if (!budget) return;
      try {
        if (budget.namespace !== actionBillingNamespace(ctx.organizationId))
          throw new AppError(
            "Actions payment ownership could not be verified",
            409,
            "ACTIONS_FUNDING_INVALID",
          );
        const api = getOblienBillingApi();
        const [current, entitlement] = await Promise.all([
          api.getBalance(budget.namespace),
          api.getEntitlement(budget.namespace),
        ]);
        if (current.billingMode === "monthly" || entitlement.capacity || current.balance === null)
          throw new AppError(
            "Actions requires a separate prepaid budget",
            409,
            "ACTIONS_FUNDING_INVALID",
          );
        // Never subtract workflow durations, reservations or locally mirrored
        // deposits. The provider has already debited compute AND transfer.
        const available = actionCreditUnits(Math.max(0, current.balance));
        const spent = actionCreditUnits(Math.max(0, entitlement.quota.used));
        Object.assign(balance, {
          availableUnits: available,
          spentUnits: spent,
          blocking: current.blocking || current.balance <= 0,
          status: "ready",
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        diagnostics.warn(
          "platform/engine/modules/actions/billing-application",
          "Actions balance is unavailable",
          error,
        );
      }
    })(),
  ]);
  return {
    currency: "usd",
    unitsPerDollar: ACTIONS_UNITS_PER_CENT * 100,
    purchasesAvailable: purchasesConfigured() && pricing.meter !== null,
    runnersReady: (budget?.runnerVersion ?? 0) >= PRICING.actions.version,
    runnerSetupFailed: budget?.runnerSetupFailed ?? false,
    balance,
    pricing,
    purchases: purchases.map(presentPurchase),
  };
}

export async function getActionsPurchase(ctx: ExecutionContext, input: { purchaseId: string }) {
  requireCloud();
  return presentPurchase(await credits().inspect(ctx.organizationId, input.purchaseId));
}

export async function createActionsCheckout(
  ctx: ExecutionContext,
  input: { amountCents: number; idempotencyKey: string },
) {
  await requirePurchases();
  return credits().checkout(ctx.organizationId, input.amountCents, input.idempotencyKey);
}

export async function resumeActionsCheckout(ctx: ExecutionContext, input: { purchaseId: string }) {
  await requirePurchases();
  return credits().resume(ctx.organizationId, input.purchaseId);
}
