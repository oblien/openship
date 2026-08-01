import { describe, expect, it } from "vitest";

import { resolveCloudResourceConfig } from "../../../src/modules/deployments/cloud-resources";
import { RESOURCE_TIER_SPECS, ALL_RESOURCE_TIERS } from "@repo/core";

/**
 * A cloud workspace is metered and must be provisioned at a concrete size, so
 * this resolver must ALWAYS return a usable ResourceConfig — never undefined.
 *
 * The regression that motivated these: `openship.json` gained a self-hosted-only
 * `tier: "unlimited"`, which is reachable input here because the value comes from
 * a repo file. Indexing the cloud tier table with it returned
 * undefined-as-ResourceConfig, and the failure surfaced much later as a
 * TypeError on `config.resources.cpuCores` inside the cloud deploy.
 */
describe("resolveCloudResourceConfig", () => {
  it("maps each cloud preset to its spec", () => {
    expect(resolveCloudResourceConfig("micro")).toEqual(RESOURCE_TIER_SPECS.micro);
    expect(resolveCloudResourceConfig("low")).toEqual(RESOURCE_TIER_SPECS.low);
    expect(resolveCloudResourceConfig("medium")).toEqual(RESOURCE_TIER_SPECS.medium);
    expect(resolveCloudResourceConfig("high")).toEqual(RESOURCE_TIER_SPECS.high);
  });

  it("never returns undefined for ANY tier in the union", () => {
    for (const tier of ALL_RESOURCE_TIERS) {
      const out = resolveCloudResourceConfig(tier);
      expect(out, `tier ${tier} produced no config`).toBeDefined();
      expect(out.cpuCores, `tier ${tier} has no cpu`).toBeGreaterThan(0);
      expect(out.memoryMb, `tier ${tier} has no memory`).toBeGreaterThan(0);
    }
  });

  it("sizes 'unlimited' as the free tier instead of leaving it unsized", () => {
    expect(resolveCloudResourceConfig("unlimited")).toEqual(RESOURCE_TIER_SPECS.low);
  });

  it("passes usable custom values through", () => {
    expect(
      resolveCloudResourceConfig("custom", { cpuCores: 3, memoryMb: 3072, diskMb: 20480 }),
    ).toEqual({ cpuCores: 3, memoryMb: 3072, diskMb: 20480 });
  });

  it("falls back to the free tier for unusable custom values", () => {
    expect(resolveCloudResourceConfig("custom", null)).toEqual(RESOURCE_TIER_SPECS.low);
    // 0 means "no limit" self-hosted, but a metered workspace can't be unsized.
    expect(resolveCloudResourceConfig("custom", { cpuCores: 0, memoryMb: 0, diskMb: 0 })).toEqual(
      RESOURCE_TIER_SPECS.low,
    );
  });
});
