import { createHash } from "node:crypto";
import { quoteCustomResources, type CustomServerResources, type PlanLimits, type PlanTierId } from "@repo/core";
import type { BillingCustomQuote } from "@repo/contracts";
import type { OblienOffer } from "../../lib/oblien-billing-api";
import { monthlyCapacity } from "./billing-capacity";

export const CUSTOM_OFFER_VERSION = "custom-v3";
export const isCustomOfferVersion = (version?: string) => version === CUSTOM_OFFER_VERSION || version === "custom-v2" || version === "custom-v1";

/** Binds the complete retail terms, including limits, to checkout retries.
 * Key order is canonical because the provider may reorder its saved snapshot. */
function customOfferReference(tier: PlanTierId, limits: PlanLimits, offer: OblienOffer, interval: "monthly" | "annual" = "monthly", legacy = false): string {
  const { reference: _reference, ...terms } = offer;
  const snapshot = JSON.stringify({ tier, limits, offer: terms, ...(legacy ? {} : { interval }) }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
  const legacyVersion = offer.billingMode === "monthly" ? "v2" : "v1";
  const version = legacy ? legacyVersion : "v3";
  return `openship:custom:${version}:${createHash("sha256").update(snapshot).digest("hex")}`;
}

export function customSubscriptionOffer(resources: CustomServerResources, interval: "monthly" | "annual" = "monthly") {
  const terms = quoteCustomResources(resources, undefined, interval);
  const offer: OblienOffer = {
    name: "Openship Custom",
    description: `${resources.cpuCores} vCPU · ${resources.memoryMb / 1024} GB RAM · ${resources.diskGb} GB disk. CPU, RAM and storage are covered for the paid ${interval === "annual" ? "year" : "month"}.`,
    unitAmount: terms.priceCents,
    currency: "usd",
    billingMode: "monthly",
    credits: 0,
    capacity: monthlyCapacity(terms.resourceLimits),
    resourceLimits: terms.resourceLimits,
  };
  offer.reference = customOfferReference(terms.basePlanTierId, terms.limits, offer, interval);
  const quote: BillingCustomQuote = {
    interval,
    basePlanTierId: terms.basePlanTierId,
    resources: terms.resources,
    reference: offer.reference,
    priceCents: terms.priceCents,
    currency: "usd",
    billingMode: "monthly",
    monthlyCredits: null,
    breakdown: terms.breakdown,
  };
  return { quote, offer, limits: terms.limits };
}

/** Renewals verify the saved contract without consulting today's retail rates. */
export function validCustomOffer(tier: PlanTierId, limits: PlanLimits, offer: OblienOffer, interval: "monthly" | "annual" = "monthly"): boolean {
  const resources = offer.resourceLimits;
  const service = limits.maxServiceResources;
  const monthly = offer.billingMode === "monthly";
  const legacy = !offer.reference?.startsWith("openship:custom:v3:");
  return Boolean((!legacy || interval === "monthly") && resources && service && (monthly ? !offer.policy && offer.credits === 0 : offer.policy) &&
    offer.credits <= offer.unitAmount &&
    resources.max_workspaces === 1 &&
    Object.values(resources).every(value => Number.isSafeInteger(value) && value! > 0) &&
    resources.max_vcpus === resources.max_total_vcpus &&
    resources.max_ram_mb === resources.max_total_ram_mb &&
    resources.max_disk_gb === resources.max_total_disk_gb &&
    service.cpuCores === resources.max_vcpus && service.memoryMb === resources.max_ram_mb &&
    offer.reference === customOfferReference(tier, limits, offer, interval, legacy));
}
