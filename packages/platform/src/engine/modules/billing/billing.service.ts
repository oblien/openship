/** Customer billing delegates to Oblien Mode B; no Stripe SDK or credit writes. */
import { createHash } from "node:crypto";
import { AppError, type PlanTierId } from "@repo/core";
import { runtimeTarget, env } from "../../config/env";
import type { ExecutionContext as RequestContext } from "../../../context";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { ensureNamespace } from "../../lib/openship-cloud";
import { getCloudBillingCatalog, OBLIEN_PLAN_IDS } from "./billing-catalog";
import { syncOblienEntitlement } from "./billing-oblien-quota";
import { fromOblienCredits } from "./billing-credit-units";
import { listLiveSubscriptions } from "./billing.repository";
import { canTopUpCloudSubscription, presentCloudSubscription } from "./billing-subscription";

export function assertBillingEnabled(): void {
  if (!env.BILLING_ENABLED) {
    throw new AppError("Billing is not enabled yet. It's coming soon to Openship Cloud.", 403, "BILLING_NOT_ENABLED");
  }
}

export function assertTopupsEnabled(): void {
  assertBillingEnabled();
  if (!env.BILLING_TOPUPS_ENABLED) {
    throw new AppError("One-time credit top-ups are not available yet.", 403, "BILLING_TOPUPS_NOT_ENABLED");
  }
}

function checkoutKey(orgId: string, resource: string, requestKey?: string): string {
  // Scope a caller's key to its authenticated organization and selected purchase.
  // Older clients get a retry window; new clients supply a UUID per purchase.
  const nonce = requestKey ?? String(Math.floor(Date.now() / (15 * 60_000)));
  return "openship:" + createHash("sha256").update(JSON.stringify([orgId, resource, nonce])).digest("hex");
}

async function assertNoLegacySubscription(orgId: string): Promise<void> {
  if ((await listLiveSubscriptions(orgId)).length) {
    throw new AppError("This account's subscription needs to be migrated before making another purchase. Contact support.", 409, "BILLING_MIGRATION_REQUIRED");
  }
}

async function topupNamespace(orgId: string): Promise<string> {
  const namespace = await ensureNamespace(orgId);
  // Do not sell through an older provider deployment whose checkout/portal
  // still shares the owner's Stripe customer. Require the namespace billing
  // contract before starting either kind of purchase.
  const { subscription } = await getOblienBillingApi().getSubscription(namespace);
  if (!canTopUpCloudSubscription(subscription)) {
    throw new AppError("An active Cloud subscription is required before adding credits", 402, "CLOUD_PLAN_REQUIRED");
  }
  return namespace;
}

export async function createCheckoutSession(
  ctx: RequestContext,
  planTierId: PlanTierId,
  interval: "monthly" | "annual",
  requestKey?: string,
): Promise<{ checkoutUrl: string }> {
  assertBillingEnabled();
  await assertNoLegacySubscription(ctx.organizationId);
  const catalog = await getCloudBillingCatalog({ fresh: true });
  const plan = catalog.plans.find((item) => item.tierId === OBLIEN_PLAN_IDS[planTierId]);
  const price = interval === "annual" ? plan?.priceYearly : plan?.priceMonthly;
  if (!plan || price == null || price <= 0) {
    throw new AppError("This plan is not available for checkout", 400, "BILLING_PLAN_NOT_PURCHASABLE");
  }
  const namespace = await ensureNamespace(ctx.organizationId);
  // The entitlement read verifies this namespace's subscription too; do not
  // fetch it a second time before opening checkout.
  await syncOblienEntitlement(ctx.organizationId, { syncResourceLimits: false });
  // Oblien replaces only this namespace's subscription after payment. This
  // starts a full-price cycle without proration; disclose that before checkout.
  const result = await getOblienBillingApi().createCheckout({
    namespace, kind: "subscription", planTierId: plan.tierId,
    billingInterval: interval === "annual" ? "yearly" : "monthly",
    successUrl: `${runtimeTarget.dashboard}/billing/overview?checkout=success&tier=${planTierId}&interval=${interval}`,
    cancelUrl: `${runtimeTarget.dashboard}/billing/plans?checkout=cancelled`,
    idempotencyKey: checkoutKey(ctx.organizationId, `subscription:${plan.tierId}:${interval}`, requestKey),
  });
  // A checkout redirect is not proof of payment. Webhooks/polling mirror access.
  return { checkoutUrl: result.url };
}

export async function createTopupCheckoutSession(ctx: RequestContext, packId: string, requestKey?: string): Promise<{ checkoutUrl: string }> {
  assertTopupsEnabled();
  await assertNoLegacySubscription(ctx.organizationId);
  const catalog = await getCloudBillingCatalog({ fresh: true });
  if (!catalog.creditPacks.some((pack) => pack.packId === packId)) {
    throw new AppError("This credit pack is no longer available", 404, "BILLING_PACK_NOT_FOUND");
  }
  const namespace = await topupNamespace(ctx.organizationId);
  const result = await getOblienBillingApi().createCheckout({
    namespace, kind: "topup", packId,
    successUrl: `${runtimeTarget.dashboard}/billing/overview?topup=success`,
    cancelUrl: `${runtimeTarget.dashboard}/billing/overview?topup=cancelled`,
    idempotencyKey: checkoutKey(ctx.organizationId, `topup:${packId}`, requestKey),
  });
  return { checkoutUrl: result.url };
}

export async function listActiveCreditPacks() {
  return (await getCloudBillingCatalog()).creditPacks.map((pack, index) => ({
    id: pack.packId, name: pack.name, credits_milli: fromOblienCredits(pack.credits),
    price_cents: Math.round(pack.price * 100), sortOrder: index, explains: null,
  }));
}

// Disabling new purchases must not prevent existing customers from stopping
// renewal or managing their invoices/payment details.
export async function createPortalSession(orgId: string): Promise<{ portalUrl: string }> {
  await assertNoLegacySubscription(orgId);
  const namespace = await ensureNamespace(orgId);
  const result = await getOblienBillingApi().createPortal({
    namespace, returnUrl: `${runtimeTarget.dashboard}/billing/overview`,
  });
  return { portalUrl: result.url };
}

export async function cancelSubscription(orgId: string) {
  await assertNoLegacySubscription(orgId);
  const namespace = await ensureNamespace(orgId);
  const result = await getOblienBillingApi().cancelSubscription(namespace);
  const subscription = presentCloudSubscription(result.subscription);
  if (!subscription || (!subscription.cancelAtPeriodEnd && subscription.status !== "canceled")) {
    throw new AppError("Cloud billing did not confirm cancellation. Please retry.", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
  }
  return { cancelAt: subscription.cancelAtPeriodEnd ? subscription.currentPeriod.end : subscription.canceledAt, subscription };
}

export async function resumeSubscription(orgId: string) {
  await assertNoLegacySubscription(orgId);
  const namespace = await ensureNamespace(orgId);
  const result = await getOblienBillingApi().resumeSubscription(namespace);
  const subscription = presentCloudSubscription(result.subscription);
  if (!subscription || subscription.cancelAtPeriodEnd || subscription.status === "canceled") {
    throw new AppError("Cloud billing did not confirm renewal. Please retry.", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
  }
  return { subscription };
}
