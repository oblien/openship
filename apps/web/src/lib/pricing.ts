import { cache } from "react";
import { z } from "zod";
import { CLOUD_API_URL, pricingUi, resolveSelfHosted, resolveStandard } from "@repo/core";

export const UI = pricingUi("en");
export const SELF_HOSTED = resolveSelfHosted("en");
export const STANDARD = resolveStandard("en");
export const CURRENCY_LD = "USD";
const cents = z.number().nonnegative().int().nullable();
const planSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), popular: z.boolean(),
  price: z.object({ monthly: cents, annual: cents }),
  features: z.array(z.string()), inheritedFrom: z.string().nullable(),
  contactSales: z.string().nullable(),
});
const catalogSchema = z.object({ data: z.object({
  provider: z.literal("oblien"), plans: z.array(planSchema).min(1),
}) });
export type CloudPlan = z.infer<typeof planSchema>;
export type PricedPlan = CloudPlan & { price: { monthly: number; annual: number | null } };
export interface CloudPricing {
  available: boolean;
  tiers: PricedPlan[];
  customTiers: CloudPlan[];
  freeTier?: PricedPlan;
}

/** A single public catalog feeds checkout, the dashboard, and marketing.
 * React cache shares a snapshot between page and JSON-LD in each render.
 * A failed or older API never falls back to unrelated, hardcoded Cloud prices. */
export const getCloudPricing = cache(async (): Promise<CloudPricing> => {
  try {
    const response = await fetch(`${CLOUD_API_URL.replace(/\/$/, "")}/api/billing/plans?locale=en`, {
      next: { revalidate: 60 }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { data } = catalogSchema.parse(await response.json());
    const tiers = data.plans.filter((plan): plan is PricedPlan => plan.price.monthly !== null);
    return {
      available: true, tiers,
      customTiers: data.plans.filter((plan) => plan.price.monthly === null),
      freeTier: tiers.find((plan) => plan.price.monthly === 0),
    };
  } catch {
    return { available: false, tiers: [], customTiers: [] };
  }
});

export function money(value: number): string {
  const digits = value % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en", {
    style: "currency", currency: CURRENCY_LD,
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value / 100);
}
export function priceLd(value: number): string { return (value / 100).toFixed(2); }
export function chooseLabel(name: string): string { return UI.ctaChoose.replace(/\{name\}/g, name); }

export function priceParts(plan: CloudPlan) {
  const price = plan.price.monthly;
  return {
    amount: price === null ? UI.custom : price === 0 ? UI.free : money(price),
    per: price !== null && price > 0 ? UI.perMonth : null,
  };
}
export function cloudFrom(pricing: CloudPricing): string | null {
  const paid = pricing.tiers.filter((plan) => plan.price.monthly > 0);
  return paid.length ? money(Math.min(...paid.map((plan) => plan.price.monthly))) : null;
}
export function paidLadder(pricing: CloudPricing): string {
  return pricing.tiers.filter((plan) => plan.price.monthly > 0)
    .map((plan) => `${plan.name} at ${money(plan.price.monthly)}${UI.perMonth}`).join(", ");
}
