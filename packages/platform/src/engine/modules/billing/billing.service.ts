/** Customer billing delegates to Oblien Mode B; no Stripe SDK or credit writes. */
import { createHash } from "node:crypto";
import { AppError, PRICING, type PlanTierId } from "@repo/core";
import { runtimeTarget, env } from "../../config/env";
import type { ExecutionContext as RequestContext } from "../../../context";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { ensureNamespace } from "../../lib/openship-cloud";
import {
  subscriptionOffer,
  subscriptionMetadata,
  topupOffer,
  subscriptionPlan,
} from "./billing-catalog";
import { syncOblienEntitlement, withCloudBillingLock } from "./billing-oblien-quota";
import { listLiveSubscriptions } from "./billing.repository";
import { canTopUpCloudSubscription, presentCloudSubscription } from "./billing-subscription";
import { fromOblienCredits } from "./billing-credit-units";

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
  // Verify the namespace's current entitlement and subscription together. A
  // raw active subscription row can outlive its paid period; only Oblien knows
  // whether a top-up can restore spending. This read also verifies its contract.
  const { subscription, entitlement } = await syncOblienEntitlement(orgId, { syncResourceLimits: false });
  if (!canTopUpCloudSubscription(subscription, entitlement)) {
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
  const offer = subscriptionOffer(planTierId, interval);
  const namespace = await ensureNamespace(ctx.organizationId);
  return withCloudBillingLock(ctx.organizationId, async (sync) => {
    // Serialize checkout creation with operator grants. Complimentary access must
    // be explicitly revoked before a customer starts a paid subscription.
    const { grant } = await sync({ syncResourceLimits: false });
    if (grant) {
      throw new AppError("This workspace has a complimentary plan. Contact support to change it.", 409, "BILLING_COMPLIMENTARY_PLAN");
    }
    await getOblienBillingApi().assertResellerSupport();
    // Oblien replaces only this namespace's subscription after payment. This
    // starts a full-price cycle without proration; disclose that before checkout.
    const result = await getOblienBillingApi().createCheckout({
      namespace,
      kind: "subscription",
      offer,
      metadata: subscriptionMetadata(planTierId, ctx.organizationId, namespace),
      billingInterval: interval === "annual" ? "yearly" : "monthly",
      successUrl: `${runtimeTarget.dashboard}/billing/overview?checkout=success&tier=${planTierId}&interval=${interval}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${runtimeTarget.dashboard}/billing/plans?checkout=cancelled`,
      idempotencyKey: checkoutKey(
        ctx.organizationId,
        `subscription:${offer.reference}:${interval}`,
        requestKey,
      ),
    });
    // A checkout redirect is not proof of payment. Webhooks/polling mirror access.
    return { checkoutUrl: result.url };
  });
}

export async function createTopupCheckoutSession(ctx: RequestContext, packId: string, requestKey?: string): Promise<{ checkoutUrl: string }> {
  assertTopupsEnabled();
  await assertNoLegacySubscription(ctx.organizationId);
  const offer = topupOffer(packId);
  const namespace = await topupNamespace(ctx.organizationId);
  await getOblienBillingApi().assertResellerSupport();
  const result = await getOblienBillingApi().createCheckout({
    namespace,
    kind: "topup",
    offer,
    metadata: {
      openship_organization: ctx.organizationId,
      openship_namespace: namespace,
      openship_pack: packId,
    },
    successUrl: `${runtimeTarget.dashboard}/billing/overview?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${runtimeTarget.dashboard}/billing/overview?topup=cancelled`,
    idempotencyKey: checkoutKey(ctx.organizationId, `topup:${packId}`, requestKey),
  });
  return { checkoutUrl: result.url };
}

export async function listActiveCreditPacks() {
  return PRICING.creditPacks.map((pack) => ({
    id: pack.id,
    name: topupOffer(pack.id).name,
    credits_milli: pack.creditsMilli,
    price_cents: pack.priceCents,
    sortOrder: pack.sortOrder,
    explains: topupOffer(pack.id).description ?? null,
  }));
}

export async function getCheckoutStatus(orgId: string, checkoutId: string) {
  const namespace = await ensureNamespace(orgId);
  const { checkout } = await getOblienBillingApi().getCheckout(namespace, checkoutId);
  const { namespaceCreditsGranted, ...state } = checkout;
  return { ...state, creditsGranted: fromOblienCredits(namespaceCreditsGranted) };
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
  subscriptionPlan(result.subscription, orgId, namespace);
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
  subscriptionPlan(result.subscription, orgId, namespace);
  const subscription = presentCloudSubscription(result.subscription);
  if (!subscription || subscription.cancelAtPeriodEnd || subscription.status === "canceled") {
    throw new AppError("Cloud billing did not confirm renewal. Please retry.", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
  }
  return { subscription };
}
