import { reportCaughtError } from "@repo/core/diagnostics";
import { cache } from "react";
import { CLOUD_API_URL, pricingUi, resolveStandard } from "@repo/core";
import { BillingPlansSchema, parseInput, type BillingPlans } from "@repo/contracts";

export const UI = pricingUi("en");
export const STANDARD = resolveStandard("en");
export const CURRENCY_LD = "USD";
export type CloudPlan = BillingPlans["plans"][number];
export type PricedPlan = CloudPlan & { price: { monthly: number; annual: number | null } };
export interface CloudPricing {
  available: boolean;
  annual: BillingPlans["annual"];
  tiers: PricedPlan[];
  customTiers: CloudPlan[];
  management?: BillingPlans["management"];
}

/** A single public catalog feeds checkout, the dashboard, and marketing.
 * React cache shares a snapshot between page and JSON-LD in each render.
 * A failed or older API never falls back to unrelated, hardcoded Cloud prices. */
export const getCloudPricing = cache(async (): Promise<CloudPricing> => {
  try {
    const response = await fetch(
      `${CLOUD_API_URL.replace(/\/$/, "")}/api/billing/plans?locale=en`,
      {
        next: { revalidate: 60 },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const data = parseInput(BillingPlansSchema, body.data);
    const tiers = data.plans.filter(
      (plan): plan is PricedPlan => plan.price.monthly !== null && plan.price.monthly > 0 && plan.availableForPurchase !== false,
    );
    if (data.provider !== "oblien") throw new Error("Cloud plans unavailable");
    return {
      available: tiers.length > 0,
      annual: data.annual,
      management: data.management,
      tiers,
      customTiers: data.plans.filter((plan) => plan.price.monthly === null),
    };
  } catch (error) {
    reportCaughtError(error, "web/lib/pricing");
    return { available: false, annual: { enabled: false, monthsFree: 0 }, tiers: [], customTiers: [] };
  }
});

export function money(value: number): string {
  const digits = value % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: CURRENCY_LD,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value / 100);
}
export function priceLd(value: number): string {
  return (value / 100).toFixed(2);
}
export function chooseLabel(name: string): string {
  return UI.ctaChoose.replace(/\{name\}/g, name);
}

export function priceParts(plan: CloudPlan, interval: "monthly" | "annual" = "monthly") {
  const price = plan.price[interval];
  return {
    amount: price === null ? UI.custom : price === 0 ? UI.free : money(interval === "annual" ? price / 12 : price),
    per: price !== null && price > 0 ? UI.perMonth : null,
  };
}
export function cloudFrom(pricing: CloudPricing): string | null {
  return pricing.tiers.length
    ? money(Math.min(...pricing.tiers.map((plan) => plan.price.monthly)))
    : null;
}
export function paidLadder(pricing: CloudPricing): string {
  return pricing.tiers
    .map((plan) => `${plan.name} at ${money(plan.price.monthly)}${UI.perMonth}`)
    .join(", ");
}
