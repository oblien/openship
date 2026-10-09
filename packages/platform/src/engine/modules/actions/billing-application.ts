import { ACTIONS_UNITS_PER_CENT, AppError, PRICING, tryWithKeyedMutex } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import type { ActionBudget, ActionCreditPurchase } from "@repo/contracts";
import { repos } from "@repo/db";
import type { Repositories } from "@repo/db/factory";
import type { ExecutionContext } from "../../../context";
import { env, localDashboardUrl } from "../../config/env";
import { encrypt, decrypt } from "../../lib/encryption";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { createProvisionLock } from "../../lib/provision-lock";
import { ActionCredits } from "./billing";
import { ensureActionsBillingNamespace } from "./billing-namespace";

// The transfer contract and trusted execution meter must be integrated before
// selling execution. This is deliberately not an environment override.
const purchasesAvailable = false;

function requireCloud() {
  if (!env.CLOUD_MODE)
    throw new AppError(
      "Actions funding is managed by Openship Cloud",
      409,
      "ACTIONS_BILLING_CLOUD_ONLY",
    );
}

function requirePurchases() {
  requireCloud();
  if (!purchasesAvailable)
    throw new AppError(
      "Cloud Actions purchases are not available yet. You can use a connected server to run workflows.",
      503,
      "ACTIONS_CHECKOUT_UNAVAILABLE",
    );
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
  const { fundedUnits = 0, spentUnits = 0, reservedUnits = 0 } = budget ?? {};
  return {
    currency: "usd",
    unitsPerDollar: ACTIONS_UNITS_PER_CENT * 100,
    purchasesAvailable,
    balance: {
      fundedUnits,
      spentUnits,
      reservedUnits,
      balanceUnits: fundedUnits - spentUnits,
      availableUnits: Math.max(0, fundedUnits - spentUnits - reservedUnits),
    },
    pricing: {
      version: PRICING.actions.version,
      transferGiBPerDollar: PRICING.actions.transferGiBPerDollar,
      depositsCents: [...PRICING.actions.depositsCents],
      runners: structuredClone(PRICING.actions.runners),
    },
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
  requirePurchases();
  return credits().checkout(ctx.organizationId, input.amountCents, input.idempotencyKey);
}

export async function resumeActionsCheckout(ctx: ExecutionContext, input: { purchaseId: string }) {
  requirePurchases();
  return credits().resume(ctx.organizationId, input.purchaseId);
}
