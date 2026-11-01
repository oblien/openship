import type { BillingPlans } from "@repo/contracts";
import type { CustomServerResources } from "@repo/core";

export type ComputePricing = NonNullable<BillingPlans["computePricing"]>;
export type PaygTier = NonNullable<BillingPlans["payg"]>["tiers"][number];

/** Selected allocation across all proposed servers, not their metered CPU activity.
 * This is a pricing preview; Oblien remains responsible for runtime admission. */
export function previewPaygPool(tier: PaygTier, resources: CustomServerResources, serverCount: number) {
  if (![resources.cpuCores, resources.memoryMb, resources.diskGb, serverCount]
    .every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const selected = {
    cpuCores: resources.cpuCores * serverCount,
    memoryMb: resources.memoryMb * serverCount,
    diskGb: resources.diskGb * serverCount,
    servers: serverCount,
  };
  if (!Object.values(selected).every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const exceeded = (Object.keys(selected) as Array<keyof typeof selected>)
    .filter(key => selected[key] > tier.pool[key]);
  return { selected, exceeded, fits: exceeded.length === 0 };
}

/** Prospective access from this credit purchase, not a customer's current entitlement. */
export function previewPaygTier(tiers: PaygTier[], purchaseCents: number) {
  if (!Number.isSafeInteger(purchaseCents) || purchaseCents <= 0) return null;
  return [...tiers].reverse().find(tier => tier.minimumFundingCents <= purchaseCents) ?? null;
}

export function hasPrepaidRates(
  pricing: BillingPlans["computePricing"],
): pricing is ComputePricing {
  return Boolean(
    pricing &&
    pricing.currency === "usd" &&
    [
      pricing.creditsPerDollar,
      pricing.usage.activeVcpuHourCents,
      pricing.usage.reservedGiBHourCents,
      pricing.usage.retainedGiBMonthCents,
      pricing.usage.monthHours,
    ].every((value) => Number.isFinite(value) && value > 0),
  );
}

/** Presentation only: published resource rates applied to prepaid usage.
 * Estimates assume identical hosts and constant utilization.
 * This must never be used for wallet debits, admission or paid entitlement. */
export function estimatePrepaidUsage({
  pricing,
  resources,
  packageCents,
  serverCount,
  cpuPercent,
}: {
  pricing: BillingPlans["computePricing"];
  resources: CustomServerResources;
  packageCents: number;
  serverCount: number;
  cpuPercent: number;
}) {
  if (
    !hasPrepaidRates(pricing) ||
    ![
      resources.cpuCores,
      resources.memoryMb,
      resources.diskGb,
      packageCents,
      serverCount,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !Number.isFinite(cpuPercent) ||
    cpuPercent < 0 ||
    cpuPercent > 100
  )
    return null;

  const creditsPerCent = pricing.creditsPerDollar / 100;
  const monthHours = pricing.usage.monthHours;
  // Resource-hours consumed during ONE elapsed hour across the selected hosts.
  // CPU activity is a fraction of each host's allocated vCPUs, not an hour count.
  const hourlyUsage = {
    cpuVcpuHours: ((resources.cpuCores * cpuPercent) / 100) * serverCount,
    memoryGiBHours: (resources.memoryMb / 1024) * serverCount,
    storageGiBHours: resources.diskGb * serverCount,
  };
  const hourlyCents = {
    cpu: hourlyUsage.cpuVcpuHours * pricing.usage.activeVcpuHourCents,
    memory: hourlyUsage.memoryGiBHours * pricing.usage.reservedGiBHourCents,
    disk: (hourlyUsage.storageGiBHours * pricing.usage.retainedGiBMonthCents) / monthHours,
  };
  const totalHourlyCents = hourlyCents.cpu + hourlyCents.memory + hourlyCents.disk;
  const idleHourlyCents = hourlyCents.memory + hourlyCents.disk;
  const fullCpuCents = resources.cpuCores * serverCount * pricing.usage.activeVcpuHourCents;
  const fullCpuHourlyCents = fullCpuCents + idleHourlyCents;
  if (
    ![totalHourlyCents, idleHourlyCents, fullCpuHourlyCents, packageCents * creditsPerCent].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const coveredElapsedHours = packageCents / totalHourlyCents;
  const durationRange = {
    minElapsedHours: packageCents / fullCpuHourlyCents,
    maxElapsedHours: packageCents / idleHourlyCents,
  };
  if (
    ![
      coveredElapsedHours,
      durationRange.minElapsedHours,
      durationRange.maxElapsedHours,
    ].every((value) => Number.isFinite(value) && value > 0)
  )
    return null;

  return {
    balanceCredits: packageCents * creditsPerCent,
    hourlyUsage,
    hourlyCents,
    totalHourlyCents,
    hourlyCredits: totalHourlyCents * creditsPerCent,
    coveredElapsedHours,
    // Only CPU activity varies. RAM and retained storage stay charged at both
    // ends; this is an estimate range, not a guaranteed lifetime for the funds.
    durationRange,
  };
}
