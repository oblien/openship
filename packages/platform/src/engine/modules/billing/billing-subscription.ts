import { PRICING } from "@repo/core";
import type { BillingSubscription, BillingPlanChange } from "@repo/contracts";
import type { CloudSubscriptionChangeIntent } from "@repo/db";
import type { OblienEntitlement, OblienSubscription, OblienPlanChange, OblienOffer } from "../../lib/oblien-billing-api";
import { subscriptionPlan } from "./billing-catalog";
import { isCustomOfferVersion } from "./billing-custom-offer";

/** A live contract must change in place. Creating another checkout would
 * replace it at full price and discard the customer's remaining paid period. */
export function canStartCloudSubscription(subscription: OblienSubscription): boolean {
  return subscription === null || subscription?.status === "canceled";
}

export function hasPendingSubscriptionChange(intent?: CloudSubscriptionChangeIntent | null): boolean {
  return Boolean(intent?.confirmationKey && !intent.completed);
}

export function canChangeCloudSubscription(subscription: OblienSubscription, entitlement?: OblienEntitlement): boolean {
  return subscription?.tierId === "reseller" && subscription.status === "active" &&
    Boolean(subscription.offer) && !subscription.cancelAtPeriodEnd && !subscription.pendingChange &&
    (!entitlement || ["active", "credit_exhausted"].includes(entitlement.status)) &&
    (subscription.billingInterval === "monthly" || PRICING.annual.enabled);
}

export function presentChangeOffer(offer: OblienOffer): BillingPlanChange["next"] {
  return {
    name: offer.name, priceCents: offer.unitAmount,
    ...(offer.resourceLimits ? { resourceLimits: {
      ...offer.resourceLimits, max_total_vcpus: offer.resourceLimits.max_total_vcpus ?? null,
      max_total_ram_mb: offer.resourceLimits.max_total_ram_mb ?? null,
      max_total_disk_gb: offer.resourceLimits.max_total_disk_gb ?? null,
    } } : {}),
  };
}

/** Payment links are validated at the adapter boundary; raw provider errors,
 * namespace IDs, metadata and Stripe identifiers never reach this view. */
export function presentSubscriptionChange(change: OblienPlanChange): BillingPlanChange {
  return {
    id: change.id, direction: change.direction, status: change.status,
    current: presentChangeOffer(change.current), next: presentChangeOffer(change.next),
    effectiveAt: change.effectiveAt, amountDueNow: change.amountDueNow, currency: change.currency,
    paymentUrl: change.payment?.url ?? null, paymentExpiresAt: change.payment?.expiresAt ?? null,
    errorCode: change.error && /^[a-z][a-z0-9_]{0,79}$/.test(change.error.code) ? change.error.code : null,
    cancelable: change.cancelable, appliedAt: change.appliedAt,
  };
}

/** Extra credits are useful only while a customer's paid plan permits Cloud work. */
export function canTopUpCloudSubscription(
  subscription: OblienSubscription,
  entitlement: OblienEntitlement,
): boolean {
  return (
    subscription !== null && subscription.offer?.billingMode !== "monthly" && entitlement.billingMode !== "monthly" &&
    subscriptionPlan(subscription).tier !== "free" &&
    ["active", "trialing"].includes(subscription.status) &&
    // The management record may remain active after its paid period expires.
    // Oblien's entitlement decides whether more credits can restore Cloud work.
    ["active", "credit_exhausted"].includes(entitlement.status)
  );
}

/** Keep provider identifiers out of the public application contract. */
export function presentCloudSubscription(subscription: OblienSubscription): BillingSubscription | null {
  if (!subscription) return null;
  return {
    tier: subscriptionPlan(subscription).tier,
    billingMode: subscription.offer?.billingMode === "monthly" ? "monthly" : "metered",
    configuration: isCustomOfferVersion(subscription.metadata?.openship_offer_version) ? "custom" : "preset",
    offerReference: subscription.offer?.reference,
    status: subscription.status,
    interval: subscription.billingInterval === "yearly" ? "annual" : "monthly",
    currentPeriod: { start: subscription.periodStart, end: subscription.periodEnd },
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt,
    pendingChange: subscription.pendingChange ? presentSubscriptionChange(subscription.pendingChange) : null,
  };
}
