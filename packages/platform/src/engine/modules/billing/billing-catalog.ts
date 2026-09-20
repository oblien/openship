import { AppError, planLimits, pricingUi, resolvePlan, toPricingLocale, type PlanTierId } from "@repo/core";
import type { BillingPlans } from "@repo/contracts";
import { getOblienBillingApi } from "../../lib/oblien-client";
import type { OblienBillingCatalog } from "../../lib/oblien-billing-api";
import { fromOblienCredits } from "./billing-credit-units";

// Existing organization IDs remain stable. Names, money and credit grants come
// from Oblien; Openship owns the application limits and localized product copy.
export const OBLIEN_PLAN_IDS: Readonly<Record<PlanTierId, string>> = {
  free: "free", starter: "hobby", pro: "pro", team: "scale", enterprise: "enterprise",
};

/** Oblien's published namespace traffic allowances (decimal GB/month).
 * https://oblien.com/docs/concepts/limits — independent of compute credits.
 * Openship has no free Cloud tier. Requests have no separate numeric allowance.
 */
export const CLOUD_EDGE_BANDWIDTH_GB: Readonly<Record<PlanTierId, number | null>> = {
  free: 0, starter: 50, pro: 500, team: 2000, enterprise: null,
};

export function openshipTier(providerTier: string | null): PlanTierId {
  if (providerTier === null || providerTier === "free") return "free";
  const tier = (Object.keys(OBLIEN_PLAN_IDS) as PlanTierId[]).find((id) => OBLIEN_PLAN_IDS[id] === providerTier);
  if (!tier) throw new AppError("This cloud plan is not supported by this Openship version", 503, "OBLIEN_PLAN_UNSUPPORTED");
  return tier;
}

let cached: { expiresAt: number; catalog: OblienBillingCatalog } | undefined;
let pending: Promise<OblienBillingCatalog> | undefined;

export async function getCloudBillingCatalog(options?: { fresh?: boolean }): Promise<OblienBillingCatalog> {
  if (!options?.fresh && cached && cached.expiresAt > Date.now()) return structuredClone(cached.catalog);
  pending ??= getOblienBillingApi().getCatalog().then((catalog) => {
    if ([...catalog.plans, ...catalog.creditPacks].some((item) => item.currency.toUpperCase() !== "USD")) {
      throw new AppError("Cloud billing currency is not supported by this Openship version", 503, "OBLIEN_CURRENCY_UNSUPPORTED");
    }
    cached = { catalog, expiresAt: Date.now() + 60_000 };
    return catalog;
  }).finally(() => { pending = undefined; });
  return structuredClone(await pending);
}

export function presentCloudPlans(catalog: OblienBillingCatalog, requestedLocale?: string): BillingPlans {
  const locale = toPricingLocale(requestedLocale);
  const plans = catalog.plans.map((plan) => {
    const id = openshipTier(plan.tierId);
    const monthly = plan.priceMonthly === null ? null : Math.round(plan.priceMonthly * 100);
    const annual = plan.priceYearly === null ? null : Math.round(plan.priceYearly * 100);
    return {
      id, name: plan.name, description: id === "free" ? "" : resolvePlan(id, locale).description, popular: plan.popular ?? false,
      price: { monthly, annual }, effectivePrice: { monthly }, listPrice: { monthly }, campaign: null,
      monthlyCredits: plan.creditsPerCycle === null ? null : fromOblienCredits(plan.creditsPerCycle),
      annualCredits: plan.yearlyCreditsPerCycle === null ? null : fromOblienCredits(plan.yearlyCreditsPerCycle),
      limits: { ...planLimits(id), computeMinutesPerMonth: null, workloads: [...planLimits(id).workloads] },
      edge: { bandwidthGb: CLOUD_EDGE_BANDWIDTH_GB[id] },
      features: plan.features, inheritedFrom: null, support: "", contactSales: monthly === null ? "mailto:support@openship.io" : null,
    };
  });
  return {
    provider: "oblien", locale, annual: { enabled: plans.some((plan) => plan.price.annual !== null), monthsFree: 0 },
    ui: pricingUi(locale), plans,
  };
}

export async function cloudPlan(tier: PlanTierId) {
  const catalog = await getCloudBillingCatalog();
  return presentCloudPlans(catalog).plans.find((plan) => plan.id === tier) ?? null;
}

export function __resetCloudBillingCatalogForTests(): void { cached = undefined; pending = undefined; }
