import { createHash } from "node:crypto";
import { quoteCustomResources, type CustomServerResources, type PlanLimits, type PlanTierId } from "@repo/core";
import type { BillingCustomQuote } from "@repo/contracts";
import type { OblienOffer } from "../../lib/oblien-billing-api";
import { fromOblienCredits } from "./billing-credit-units";

export const CUSTOM_OFFER_VERSION = "custom-v1";

/** Binds the complete retail terms, including limits, to checkout retries.
 * Key order is canonical because the provider may reorder its saved snapshot. */
function customOfferReference(tier: PlanTierId, limits: PlanLimits, offer: OblienOffer): string {
  const { reference: _reference, ...terms } = offer;
  const snapshot = JSON.stringify({ tier, limits, offer: terms }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
  return `openship:custom:v1:${createHash("sha256").update(snapshot).digest("hex")}`;
}

export function customSubscriptionOffer(resources: CustomServerResources) {
  const terms = quoteCustomResources(resources);
  const offer: OblienOffer = {
    name: "Openship Custom",
    description: `${resources.cpuCores} vCPU · ${resources.memoryMb / 1024} GB RAM · ${resources.diskGb} GB disk. Builds and apps share the included metered usage allowance.`,
    unitAmount: terms.priceCents,
    currency: "usd",
    credits: terms.creditsPerCycle,
    policy: terms.policy,
    resourceLimits: terms.resourceLimits,
  };
  offer.reference = customOfferReference(terms.basePlanTierId, terms.limits, offer);
  const quote: BillingCustomQuote = {
    basePlanTierId: terms.basePlanTierId,
    resources: terms.resources,
    reference: offer.reference,
    priceCents: terms.priceCents,
    currency: "usd",
    monthlyCredits: fromOblienCredits(terms.creditsPerCycle),
    breakdown: terms.breakdown,
  };
  return { quote, offer, limits: terms.limits };
}

/** Renewals verify the saved contract without consulting today's retail rates. */
export function validCustomOffer(tier: PlanTierId, limits: PlanLimits, offer: OblienOffer): boolean {
  const resources = offer.resourceLimits;
  const service = limits.maxServiceResources;
  return Boolean(resources && service && offer.policy &&
    offer.credits <= offer.unitAmount &&
    resources.max_workspaces === 1 &&
    Object.values(resources).every(value => Number.isSafeInteger(value) && value! > 0) &&
    resources.max_vcpus === resources.max_total_vcpus &&
    resources.max_ram_mb === resources.max_total_ram_mb &&
    resources.max_disk_gb === resources.max_total_disk_gb &&
    service.cpuCores === resources.max_vcpus && service.memoryMb === resources.max_ram_mb &&
    offer.reference === customOfferReference(tier, limits, offer));
}
