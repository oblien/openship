import type { AffiliatePublicOffer } from "@repo/contracts";
import type { ApiPlan } from "@/components/billing/PricingCards";
import { serverPlanChoices } from "@/components/billing/plan-presentation";

/** Match the provider's VM capacity identity, independently of marketing tier names. */
export function referralPlanId(plan: ApiPlan): string | null {
  const pool = plan.resourceLimits;
  if (!pool?.max_total_vcpus || !pool.max_total_ram_mb || !pool.max_total_disk_gb) return null;
  return `vm:${pool.max_total_vcpus}:${pool.max_total_ram_mb}:${pool.max_total_disk_gb}`;
}

export function referralPlans(
  plans: ApiPlan[],
  offer: Pick<AffiliatePublicOffer, "minimumMonthlyCents" | "planId" | "eligiblePlans"> | undefined,
  interval: "monthly" | "annual",
) {
  return serverPlanChoices({ plans, interval }).available.filter(
    (plan) =>
      plan.billingMode === "monthly" &&
      referralPlanId(plan) !== null &&
      (!offer ||
        (plan.price[interval]! >= offer.minimumMonthlyCents * (interval === "annual" ? 12 : 1) &&
          (!offer.planId || offer.planId === referralPlanId(plan)) &&
          (!offer.eligiblePlans ||
            offer.eligiblePlans.some(
              (selection) =>
                selection.planId === referralPlanId(plan) && selection.intervals.includes(interval),
            )))),
  );
}
