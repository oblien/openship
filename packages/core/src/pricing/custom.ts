import { ValidationError } from "../errors";
import { PRICING, type OblienLimits, type PlanLimits, type PlanTierId } from "./index";
import type { PricingCatalogRaw } from "./schema";

export interface CustomServerResources {
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
}

/** Openship retail bundle pricing. Oblien validates funding and reserves the
 * pool at checkout; this calculation never grants paid coverage. */
export function quoteCustomResources(resources: CustomServerResources, catalog: PricingCatalogRaw = PRICING, interval: "monthly" | "annual" = "monthly") {
  for (const key of Object.keys(catalog.custom.resources) as Array<keyof CustomServerResources>) {
    const value = resources[key];
    const { min, max, step } = catalog.custom.resources[key];
    if (!Number.isSafeInteger(value) || value < min || value > max || value % step !== 0) {
      throw new ValidationError(`Choose ${key} between ${min} and ${max}, in increments of ${step}.`);
    }
  }
  const rates = interval === "annual" ? catalog.custom.extraAnnualCents : catalog.custom.extraMonthlyCents;
  const candidates = catalog.plans.flatMap(plan => {
    const basePrice = plan.price[interval];
    if (!plan.availableForPurchase || !basePrice || plan.billing.mode !== "monthly" || plan.contactSales) return [];
    const included = plan.billing.resourceLimits;
    const breakdown = {
      basePriceCents: basePrice,
      cpuCents: Math.max(0, resources.cpuCores - included.max_total_vcpus!) * rates.cpuCore,
      memoryCents: Math.max(0, resources.memoryMb - included.max_total_ram_mb!) / 1024 * rates.memoryGb,
      diskCents: Math.max(0, resources.diskGb - included.max_total_disk_gb!) * rates.diskGb,
    };
    const extras = breakdown.cpuCents + breakdown.memoryCents + breakdown.diskCents;
    return [{
      plan,
      breakdown,
      priceCents: basePrice + extras,
    }];
  });
  // A richer bundle may be cheaper than adding each resource separately. Its
  // discount applies without silently changing the customer's chosen allocation.
  candidates.sort((a, b) => a.priceCents - b.priceCents);
  const selected = candidates[0];
  if (!selected || !Number.isSafeInteger(selected.priceCents) || selected.priceCents > 1_000_000) {
    throw new ValidationError("This resource configuration is not available for checkout.");
  }
  const { plan, breakdown, priceCents } = selected;
  const resourceLimits: OblienLimits = {
    max_workspaces: 1,
    max_vcpus: resources.cpuCores,
    max_total_vcpus: resources.cpuCores,
    max_ram_mb: resources.memoryMb,
    max_total_ram_mb: resources.memoryMb,
    max_disk_gb: resources.diskGb,
    max_total_disk_gb: resources.diskGb,
  };
  const limits: PlanLimits = {
    ...plan.limits,
    maxResourceTier: null,
    maxServiceResources: { cpuCores: resources.cpuCores, memoryMb: resources.memoryMb },
  };
  return {
    basePlanTierId: plan.id as PlanTierId,
    resources: { cpuCores: resources.cpuCores, memoryMb: resources.memoryMb, diskGb: resources.diskGb },
    breakdown,
    priceCents,
    creditsPerCycle: 0,
    limits,
    resourceLimits,
  };
}
