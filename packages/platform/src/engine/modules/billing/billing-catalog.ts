import {
  AppError,
  PRICING,
  PLAN_IDS,
  planLimits,
  planLimitsSchema,
  pricingUi,
  resolvePlan,
  toPricingLocale,
  type PlanLimits,
  type PlanTierId,
} from "@repo/core";
import type { BillingPlans } from "@repo/contracts";
import type { OblienOffer, OblienSubscription } from "../../lib/oblien-billing-api";
import { cloudNamespaceLimits } from "../../lib/cloud-resource-limits";
import { fromOblienCredits, toOblienCredits } from "./billing-credit-units";
import type { ResolvedPlanGrant } from "./billing-plan-grants";

// Read compatibility for subscriptions sold before Openship owned its offers.
// New checkouts never use these platform catalog IDs.
const LEGACY_PLAN_IDS: Readonly<Record<PlanTierId, string>> = {
  free: "free", starter: "hobby", pro: "pro", team: "scale", enterprise: "enterprise",
};

// Reseller offers do not inherit platform traffic tiers. Do not advertise those
// allowances for new offers without an enforced namespace traffic policy.
export const CLOUD_EDGE_BANDWIDTH_GB: Readonly<Record<PlanTierId, number | null>> = {
  free: 0,
  starter: null,
  pro: null,
  team: null,
  enterprise: null,
};

export const OFFER_VERSION = "1";
export const offerReference = (tier: PlanTierId) => `openship:${tier}:v${OFFER_VERSION}`;

function invalidContract(): never {
  throw new AppError(
    "This organization's saved Cloud offer could not be verified. Contact Openship support.",
    502,
    "OBLIEN_RESELLER_CONTRACT_INVALID",
  );
}

/** Use the paid snapshot, so editing the catalog cannot change existing contracts. */
export function subscriptionPlan(subscription: OblienSubscription, organizationId?: string, namespace?: string): {
  tier: PlanTierId; limits: PlanLimits; resourceLimits: ReturnType<typeof cloudNamespaceLimits>;
} {
  if (subscription?.tierId !== "reseller") {
    const providerTier = subscription?.tierId;
    const tier = providerTier == null ? "free" : PLAN_IDS.find(id => LEGACY_PLAN_IDS[id] === providerTier);
    if (!tier) throw new AppError("This cloud plan is not supported by this Openship version", 503, "OBLIEN_PLAN_UNSUPPORTED");
    return { tier, limits: planLimits(tier), resourceLimits: cloudNamespaceLimits(tier) };
  }
  const { offer, metadata } = subscription;
  const tier = metadata?.openship_plan as PlanTierId;
  if (!PLAN_IDS.includes(tier) || tier === "free" || !offer || offer.reference !== offerReference(tier) ||
      metadata?.openship_offer_version !== OFFER_VERSION || !metadata.openship_organization || !metadata.openship_namespace ||
      (organizationId !== undefined && metadata.openship_organization !== organizationId) ||
      (namespace !== undefined && metadata.openship_namespace !== namespace) || !offer.policy || !offer.resourceLimits) invalidContract();
  let decoded: unknown;
  try { decoded = JSON.parse(metadata.openship_limits ?? ""); } catch { invalidContract(); }
  const parsed = planLimitsSchema.strict().safeParse(decoded);
  if (!parsed.success) invalidContract();
  return { tier, limits: parsed.data, resourceLimits: offer.resourceLimits };
}

/** Openship controls the price, credit allowance and checkout copy. */
export function subscriptionOffer(tier: PlanTierId, interval: "monthly" | "annual"): OblienOffer {
  const raw = PRICING.plans.find(plan => plan.id === tier);
  const amount = raw?.price[interval];
  const credits = interval === "annual" ? raw?.billing.yearlyCreditsPerCycle : raw?.billing.creditsPerCycle;
  if (!raw || !amount || !credits || (interval === "annual" && !PRICING.annual.enabled)) {
    throw new AppError("This plan is not available for checkout", 400, "BILLING_PLAN_NOT_PURCHASABLE");
  }
  const plan = resolvePlan(tier);
  return {
    reference: offerReference(tier), name: raw.billing.checkoutName ?? `Openship ${plan.name}`,
    description: raw.billing.checkoutDescription ?? plan.description,
    unitAmount: amount, currency: "usd", credits,
    policy: { overdraft: raw.billing.overdraft, suspendThreshold: raw.billing.suspendThreshold,
      onOverdraftAction: raw.billing.onOverdraftAction },
    resourceLimits: cloudNamespaceLimits(tier),
  };
}

export function subscriptionMetadata(
  tier: PlanTierId,
  organizationId: string,
  namespace: string,
): Record<string, string> {
  return {
    openship_plan: tier,
    openship_offer_version: OFFER_VERSION,
    openship_organization: organizationId,
    openship_namespace: namespace,
    openship_limits: JSON.stringify(planLimits(tier)),
  };
}

export function topupOffer(packId: string): OblienOffer {
  const pack = PRICING.creditPacks.find((item) => item.id === packId);
  if (!pack)
    throw new AppError("This credit pack is no longer available", 404, "BILLING_PACK_NOT_FOUND");
  return {
    reference: `openship:${pack.id}:v${OFFER_VERSION}`,
    name: "Openship compute credits",
    description: `${toOblienCredits(pack.creditsMilli).toLocaleString("en-US")} additional credits for your namespace`,
    unitAmount: pack.priceCents,
    currency: "usd",
    credits: toOblienCredits(pack.creditsMilli),
  };
}

export function presentCloudPlans(requestedLocale?: string): BillingPlans {
  const locale = toPricingLocale(requestedLocale);
  const plans = PLAN_IDS.map((id) => {
    const plan = resolvePlan(id, locale);
    const raw = PRICING.plans.find((item) => item.id === id)!;
    return {
      id,
      name: raw.billing.checkoutName ?? plan.name,
      description: raw.billing.checkoutDescription ?? (id === "free" ? "" : plan.description),
      popular: plan.popular,
      price: {
        monthly: raw.price.monthly,
        annual: PRICING.annual.enabled ? raw.price.annual : null,
      },
      effectivePrice: { monthly: raw.price.monthly },
      listPrice: { monthly: raw.price.monthly },
      campaign: null,
      monthlyCredits:
        raw.billing.creditsPerCycle === null
          ? null
          : fromOblienCredits(raw.billing.creditsPerCycle),
      annualCredits:
        raw.billing.yearlyCreditsPerCycle === null
          ? null
          : fromOblienCredits(raw.billing.yearlyCreditsPerCycle),
      limits: { ...plan.limits, workloads: [...plan.limits.workloads] },
      features: [...plan.features],
      inheritedFrom: plan.inheritedFrom ?? null,
      support: plan.support,
      contactSales: plan.contactSales ?? null,
    };
  });
  return {
    provider: "oblien",
    locale,
    annual: { enabled: PRICING.annual.enabled, monthsFree: PRICING.annual.monthsFree },
    ui: pricingUi(locale),
    plans,
  };
}

export async function cloudPlan(tier: PlanTierId, subscription?: OblienSubscription) {
  const plan = presentCloudPlans().plans.find((item) => item.id === tier) ?? null;
  // Legacy subscriptions have no saved reseller price. Preserve their controls
  // and measured balance without displaying the new catalog as a past purchase.
  if (!plan || subscription?.tierId !== "reseller" || !subscription.offer) return null;
  const { limits } = subscriptionPlan(subscription);
  const offer = subscription.offer;
  const yearly = subscription.billingInterval === "yearly";
  return {
    ...plan,
    name: offer.name,
    description: offer.description ?? "",
    limits: { ...limits, workloads: [...limits.workloads] },
    features: [],
    inheritedFrom: null,
    price: { monthly: yearly ? null : offer.unitAmount, annual: yearly ? offer.unitAmount : null },
    effectivePrice: { monthly: yearly ? null : offer.unitAmount },
    listPrice: { monthly: yearly ? null : offer.unitAmount },
    monthlyCredits: yearly ? null : fromOblienCredits(offer.credits),
    annualCredits: yearly ? fromOblienCredits(offer.credits) : null,
  };
}

/** Display the saved grant as a zero-price plan, without a hosted subscription. */
export function complimentaryCloudPlan(grant: ResolvedPlanGrant) {
  const plan = presentCloudPlans().plans.find(item => item.id === grant.tier)!;
  return {
    ...plan, name: grant.offer.name, description: grant.offer.description ?? "",
    limits: { ...grant.limits, workloads: [...grant.limits.workloads] },
    features: [], inheritedFrom: null, campaign: null,
    price: { monthly: 0, annual: null }, effectivePrice: { monthly: 0 }, listPrice: { monthly: 0 },
    monthlyCredits: fromOblienCredits(grant.offer.credits), annualCredits: null,
  };
}
