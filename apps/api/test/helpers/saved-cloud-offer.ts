/** Immutable fixtures from main f9cf8890. Existing purchases must not be
 * regenerated from the current catalog in renewal/compatibility tests. */
import snapshots from "../fixtures/cloud-offers-v5.json";
import { planLimitsSchema } from "@repo/core";
import type { OblienOffer } from "@repo/platform/engine/lib/oblien-billing-api";
type Tier = keyof typeof snapshots;
export function savedOffer(tier: Tier, _interval: "monthly" = "monthly"): OblienOffer {
  return structuredClone(snapshots[tier].offer) as OblienOffer;
}
export const savedLimits = (tier: Tier) =>
  planLimitsSchema.parse(structuredClone(snapshots[tier].limits));
export function savedMetadata(
  tier: Tier,
  organizationId: string,
  namespace: string,
): Record<string, string> {
  return {
    openship_plan: tier,
    openship_offer_version: "5",
    openship_organization: organizationId,
    openship_namespace: namespace,
    openship_limits: JSON.stringify(savedLimits(tier)),
  };
}

// Last Hobby offer, captured before it was retired from new sales.
import hobbyV11 from "../fixtures/cloud-hobby-v11.json";
export const savedMonthlyHobby = (): OblienOffer => structuredClone(hobbyV11) as OblienOffer;
