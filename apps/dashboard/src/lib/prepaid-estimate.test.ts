import { describe, expect, it } from "vitest";
import { PRICING } from "@repo/core";
import { estimatePrepaidUsage, hasPrepaidRates, previewPaygPool, previewPaygTier, type ComputePricing } from "./prepaid-estimate";

const pricing: ComputePricing = {
  tariffId: "test-tariff",
  currency: "usd",
  creditsPerDollar: 100,
  paygCapPercent: 125,
  usage: {
    activeVcpuHourCents: 3,
    reservedGiBHourCents: 0.8,
    retainedGiBMonthCents: 5,
    monthHours: 720,
  },
  network: { managedProxyGiBCents: 10, minimumTopupCents: 500 },
  retentionDays: 30,
  paygCheckoutAvailable: false,
};
const input = {
  pricing,
  resources: { cpuCores: 1, memoryMb: 4096, diskGb: 25 },
  packageCents: 500,
  serverCount: 1,
  cpuPercent: 100,
};

describe("prepaid pricing preview", () => {
  it("compares every configured server with one shared tier pool", () => {
    const tier = PRICING.payg.tiers[1]!;
    expect(previewPaygPool(tier, input.resources, 4)).toEqual({
      selected: { cpuCores: 4, memoryMb: 16384, diskGb: 100, servers: 4 }, exceeded: [], fits: true,
    });
    expect(previewPaygPool(tier, input.resources, 5)?.exceeded).toEqual(["cpuCores", "memoryMb", "servers"]);
    expect(previewPaygPool(tier, { ...input.resources, diskGb: 40 }, 4)?.exceeded).toEqual(["diskGb"]);
    expect(previewPaygPool(tier, { cpuCores: 4, memoryMb: 16384, diskGb: 128 }, 1)?.fits).toBe(true);
    expect(previewPaygPool(tier, { ...input.resources, cpuCores: 1.5 }, 2)).toBeNull();
    expect(previewPaygPool(tier, input.resources, -1)).toBeNull();
  });

  it("previews the tier unlocked by a purchase without changing resource prices or credit conversion", () => {
    expect(previewPaygTier(PRICING.payg.tiers, 499)).toBeNull();
    expect(previewPaygTier(PRICING.payg.tiers, 500)?.id).toBe("tier_1");
    expect(previewPaygTier(PRICING.payg.tiers, 1999)?.id).toBe("tier_1");
    expect(previewPaygTier(PRICING.payg.tiers, 2000)?.id).toBe("tier_2");
    expect(previewPaygTier(PRICING.payg.tiers, 5000)?.id).toBe("tier_3");
    expect(previewPaygTier(PRICING.payg.tiers, 10000)?.id).toBe("tier_3");
    expect(previewPaygTier(PRICING.payg.tiers, Number.NaN)).toBeNull();
  });
  it("uses active CPU, reserved GiB of memory and retained storage, with the provider credit conversion", () => {
    const result = estimatePrepaidUsage(input)!;
    expect(result.balanceCredits).toBe(500);
    expect(result.hourlyCents.cpu).toBe(3);
    expect(result.hourlyCents.memory).toBe(3.2);
    expect(result.hourlyCents.disk * 720).toBeCloseTo(125);
    expect(result.hourlyCredits).toBeCloseTo(6.373611111);
    const otherConversion = estimatePrepaidUsage({
      ...input,
      pricing: { ...pricing, creditsPerDollar: 200 },
    })!;
    expect(otherConversion.balanceCredits).toBe(1000);
    expect(otherConversion.hourlyCredits).toBeCloseTo(result.hourlyCredits * 2);
    expect(otherConversion.coveredElapsedHours).toBe(result.coveredElapsedHours);
  });

  it("calculates the hourly rate and spends a deposit continuously", () => {
    const result = estimatePrepaidUsage(input)!;
    expect(result.totalHourlyCents).toBeCloseTo(6.373611111);
    expect(result.coveredElapsedHours).toBeCloseTo(500 / (3 + 3.2 + 125 / 720));
    expect(result.coveredElapsedHours).toBeLessThan(80);
  });

  it("extends runtime in proportion to the added credits without a monthly-plan ceiling", () => {
    const initial = estimatePrepaidUsage(input)!;
    const larger = estimatePrepaidUsage({ ...input, packageCents: 1000 })!;
    expect(larger.coveredElapsedHours).toBeCloseTo(initial.coveredElapsedHours * 2);
    const multipleMonths = estimatePrepaidUsage({ ...input, packageCents: 10000 })!;
    expect(multipleMonths.coveredElapsedHours).toBeCloseTo(10000 / initial.totalHourlyCents);
    expect(estimatePrepaidUsage({ ...input, pricing: { ...pricing, paygCapPercent: 0 } })).toEqual(initial);
  });

  it("shares the package balance across hosts without multiplying the deposit", () => {
    const result = estimatePrepaidUsage({ ...input, serverCount: 2 })!;
    expect(result.balanceCredits).toBe(500);
    expect(result.totalHourlyCents).toBeCloseTo(12.747222222);
    expect(result.hourlyCents.memory).toBe(6.4);
    expect(result.coveredElapsedHours).toBeCloseTo(
      estimatePrepaidUsage(input)!.coveredElapsedHours / 2,
    );
    expect(
      estimatePrepaidUsage({ ...input, serverCount: 2, packageCents: 9178 })!.coveredElapsedHours,
    ).toBeCloseTo(720);
  });

  it("keeps memory and disk charges when average CPU activity is zero", () => {
    const result = estimatePrepaidUsage({ ...input, cpuPercent: 0 })!;
    expect(result.hourlyCents.cpu).toBe(0);
    expect(result.hourlyUsage.cpuVcpuHours).toBe(0);
    expect(result.hourlyCents.memory).toBe(3.2);
    expect(result.hourlyCents.disk).toBeGreaterThan(0);
    expect(result.coveredElapsedHours).toBeLessThan(150);
  });

  it("shows full-CPU and idle durations without making reserved RAM or storage free", () => {
    const result = estimatePrepaidUsage(input)!;
    expect(result.durationRange.minElapsedHours).toBeCloseTo(500 / (3 + 3.2 + 125 / 720));
    expect(result.durationRange.maxElapsedHours).toBeCloseTo(500 / (3.2 + 125 / 720));
    const funded = estimatePrepaidUsage({ ...input, packageCents: 4589 })!;
    expect(funded.durationRange.minElapsedHours).toBeCloseTo(720);
    expect(funded.durationRange.maxElapsedHours).toBeCloseTo(4589 / (3.2 + 125 / 720));
    const twoHosts = estimatePrepaidUsage({ ...input, serverCount: 2 })!;
    expect(twoHosts.durationRange.maxElapsedHours).toBeCloseTo(result.durationRange.maxElapsedHours / 2);
  });

  it.each([0, 0.1, 25, 100])("keeps the selected %s%% CPU estimate within the same usage range", (cpuPercent) => {
    const result = estimatePrepaidUsage({ ...input, cpuPercent })!;
    const baseline = estimatePrepaidUsage(input)!;
    expect(result.durationRange).toEqual(baseline.durationRange);
    expect(result.coveredElapsedHours).toBeGreaterThanOrEqual(result.durationRange.minElapsedHours);
    expect(result.coveredElapsedHours).toBeLessThanOrEqual(result.durationRange.maxElapsedHours);
  });

  it("distinguishes vCPU-hours from elapsed time using allocated CPU and average activity", () => {
    const configuration = {
      ...input,
      resources: { cpuCores: 4, memoryMb: 16384, diskGb: 128 },
    };
    const quarter = estimatePrepaidUsage({ ...configuration, cpuPercent: 25 })!;
    const full = estimatePrepaidUsage({ ...configuration, cpuPercent: 100 })!;
    // One elapsed hour with four vCPUs at 25% uses one vCPU-hour, not four.
    expect(quarter.hourlyUsage).toEqual({
      cpuVcpuHours: 1,
      memoryGiBHours: 16,
      storageGiBHours: 128,
    });
    expect(quarter.hourlyCents.cpu).toBe(3);
    expect(full.hourlyUsage.cpuVcpuHours).toBe(4);
    expect(full.hourlyCents.cpu).toBe(12);
    expect(quarter.hourlyCents.memory).toBe(full.hourlyCents.memory);
    expect(quarter.hourlyCents.disk).toBe(full.hourlyCents.disk);
    expect(quarter.coveredElapsedHours).toBeCloseTo(500 / (3 + 16 * 0.8 + (128 * 5) / 720));
    expect(quarter.coveredElapsedHours).toBeGreaterThan(full.coveredElapsedHours);
    // Doubling concurrent hosts doubles resource-hours, not elapsed time.
    const pair = estimatePrepaidUsage({ ...configuration, cpuPercent: 25, serverCount: 2 })!;
    expect(pair.hourlyUsage).toEqual({ cpuVcpuHours: 2, memoryGiBHours: 32, storageGiBHours: 256 });
    expect(pair.coveredElapsedHours).toBeCloseTo(quarter.coveredElapsedHours / 2);
  });

  it.each([
    { serverCount: 0 },
    { serverCount: 1.5 },
    { cpuPercent: -1 },
    { cpuPercent: 101 },
    { packageCents: 0 },
    { packageCents: 1.5 },
    { resources: { ...input.resources, cpuCores: Number.NaN } },
    { resources: { ...input.resources, memoryMb: -1 } },
  ])("does not show a price for invalid inputs: %j", (changes) => {
    expect(estimatePrepaidUsage({ ...input, ...changes })).toBeNull();
  });

  it("does not invent rates or render infinite prices when the catalog is unavailable or malformed", () => {
    expect(hasPrepaidRates(undefined)).toBe(false);
    expect(estimatePrepaidUsage({ ...input, pricing: undefined })).toBeNull();
    expect(
      estimatePrepaidUsage({ ...input, pricing: { ...pricing, creditsPerDollar: 0 } }),
    ).toBeNull();
    expect(
      estimatePrepaidUsage({ ...input, pricing: { ...pricing, usage: { ...pricing.usage, monthHours: 0 } } }),
    ).toBeNull();
    expect(
      estimatePrepaidUsage({
        ...input,
        pricing: {
          ...pricing,
          usage: { ...pricing.usage, reservedGiBHourCents: Number.MAX_VALUE },
        },
      }),
    ).toBeNull();
  });
});
