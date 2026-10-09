import { ACTIONS_UNITS_PER_CENT, AppError, PRICING } from "@repo/core";
import type { ActionBudget, ActionCreditPurchase } from "@repo/contracts";
import { repos } from "@repo/db";
import type { Repositories } from "@repo/db/factory";
import type { ExecutionContext } from "../../../context";
import { env, localDashboardUrl } from "../../config/env";
import { encrypt, decrypt } from "../../lib/encryption";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { createProvisionLock } from "../../lib/provision-lock";
import { ActionCredits } from "./billing";

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
    lock: (org, work) => createProvisionLock(`actions-billing:${org}`).run(work),
    encrypt,
    decrypt,
    dashboardUrl: localDashboardUrl,
  });
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
