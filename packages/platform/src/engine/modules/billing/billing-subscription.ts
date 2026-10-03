import type { BillingSubscription } from "@repo/contracts";
import type { OblienEntitlement, OblienSubscription } from "../../lib/oblien-billing-api";
import { subscriptionPlan } from "./billing-catalog";
import { CUSTOM_OFFER_VERSION } from "./billing-custom-offer";

/** A live contract must change in place. Creating another checkout would
 * replace it at full price and discard the customer's remaining paid period. */
export function canStartCloudSubscription(subscription: OblienSubscription): boolean {
  return subscription === null || subscription?.status === "canceled";
}

/** Extra credits are useful only while a customer's paid plan permits Cloud work. */
export function canTopUpCloudSubscription(
  subscription: OblienSubscription,
  entitlement: OblienEntitlement,
): boolean {
  return (
    subscription !== null &&
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
    configuration: subscription.metadata?.openship_offer_version === CUSTOM_OFFER_VERSION ? "custom" : "preset",
    offerReference: subscription.offer?.reference,
    status: subscription.status,
    interval: subscription.billingInterval === "yearly" ? "annual" : "monthly",
    currentPeriod: { start: subscription.periodStart, end: subscription.periodEnd },
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt,
  };
}
