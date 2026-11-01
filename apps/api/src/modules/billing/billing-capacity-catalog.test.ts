import { describe, expect, it, vi } from "vitest";
import legacyCustom from "../../../test/fixtures/cloud-custom-v2.json";
import { PRICING, planServiceResources } from "@repo/core";
import { BillingPlansSchema } from "@repo/contracts";
import { Value } from "@sinclair/typebox/value";
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient() { throw new Error("Capacity must be provider-enforced, not computed from owner resources"); } }));
import { cloudPlan, presentCloudPlans, subscriptionMetadata, subscriptionOffer, subscriptionPlan, topupOffer } from "@repo/platform/engine/modules/billing/billing-catalog";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
import { savedOffer, savedMetadata, savedMonthlyHobby } from "../../../test/helpers/saved-cloud-offer";
import capacityFixture from "../../../test/fixtures/oblien-capacity-catalog.json";
import { oblienCapacityCatalogSchema } from "@repo/platform/engine/lib/oblien-capacity";

const savedPro = (): NonNullable<OblienSubscription> => ({ tierId: "reseller", status: "active", billingInterval: "monthly",
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", cancelAtPeriodEnd: false, canceledAt: null,
  offer: savedOffer("pro"), metadata: savedMetadata("pro", "org-a", "ns-a") });
const monthlyPro = (): NonNullable<OblienSubscription> => ({ ...savedPro(),
  offer: subscriptionOffer("pro", "monthly"), metadata: subscriptionMetadata("pro", "org-a", "ns-a") });

describe("funded Cloud offers and isolated capacity", () => {
  it("publishes Openship PAYG pool tiers independently of provider account plans and usage prices", () => {
    const catalog = presentCloudPlans();
    expect(catalog.payg).toEqual(PRICING.payg);
    expect(Value.Check(BillingPlansSchema, catalog)).toBe(true);
    expect(catalog.payg?.tiers.map(tier => tier.minimumFundingCents)).toEqual([500, 2000, 5000]);
    catalog.payg!.tiers[0]!.pool.cpuCores = 999;
    expect(presentCloudPlans().payg!.tiers[0]!.pool.cpuCores).toBe(2);
    expect(catalog.computePricing).toBeUndefined();
  });
  it("publishes the provider's credit conversion and cap factor without activating customer PAYG checkout", () => {
    const provider = oblienCapacityCatalogSchema.parse(capacityFixture);
    provider.tariff.creditsPerDollar = 200;
    provider.tariff.paygCapPercent = 130;
    const catalog = presentCloudPlans("en", provider);
    expect(Value.Check(BillingPlansSchema, catalog)).toBe(true);
    expect(catalog.computePricing).toMatchObject({
      creditsPerDollar: 200, paygCapPercent: 130,
      usage: provider.tariff.usage, paygCheckoutAvailable: false,
    });
    expect(presentCloudPlans().computePricing).toBeUndefined();
  });
  it("sells the approved monthly prices with explicit pools and no credit policy", () => {
    for (const tier of ["hobby", "starter", "pro", "team"] as const) {
      const offer = subscriptionOffer(tier, "monthly");
      expect(offer.credits).toBe(0);
      expect(offer.billingMode).toBe("monthly");
      expect(offer.capacity).toEqual({ vcpus: offer.resourceLimits!.max_total_vcpus,
        memoryMb: offer.resourceLimits!.max_total_ram_mb, diskGb: offer.resourceLimits!.max_total_disk_gb, workspaces: 1 });
      expect(Object.values(offer.resourceLimits!).every(value => Number.isInteger(value) && value! > 0)).toBe(true);
      expect(offer.policy).toBeUndefined();
      expect(presentCloudPlans().plans.find(plan => plan.id === tier)?.resourceLimits).toEqual(offer.resourceLimits);
      expect(offer.reference).toBe(`openship:${tier}:v13`);
      const saved = subscriptionPlan({ ...savedPro(), offer, metadata: subscriptionMetadata(tier, "org-a", "ns-a") });
      const published = presentCloudPlans().plans.find(plan => plan.id === tier)!;
      expect(planServiceResources(saved.limits)).toEqual(planServiceResources(published.limits));
    }
    expect(Value.Check(BillingPlansSchema, presentCloudPlans())).toBe(true);
  });
  it.each([
    ["hobby", 1, 4096, 25], ["starter", 2, 8192, 32], ["pro", 4, 16384, 128], ["team", 8, 32768, 256],
  ] as const)("retains the saved monthly v9 %s allocation after publishing v13", async (tier, vcpus, memoryMb, diskGb) => {
    const offer = tier === "hobby" ? savedMonthlyHobby() : subscriptionOffer(tier, "monthly");
    const metadata = subscriptionMetadata(tier, "org-a", "ns-a");
    offer.reference = `openship:${tier}:v9`;
    offer.capacity = { vcpus, memoryMb, diskGb, workspaces: 1 };
    offer.resourceLimits = { max_workspaces: 1, max_vcpus: vcpus, max_ram_mb: memoryMb, max_disk_gb: diskGb,
      max_total_vcpus: vcpus, max_total_ram_mb: memoryMb, max_total_disk_gb: diskGb };
    metadata.openship_offer_version = "9";
    metadata.openship_limits = JSON.stringify({ ...JSON.parse(metadata.openship_limits!),
      maxServiceResources: { cpuCores: vcpus, memoryMb } });
    const subscription = { ...savedPro(), offer, metadata };
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription, "org-a", "ns-a")).toMatchObject({
      resourceLimits: offer.resourceLimits, limits: { maxServiceResources: { cpuCores: vcpus, memoryMb } },
    });
    expect(await cloudPlan(tier, subscription)).toMatchObject({
      price: { monthly: offer.unitAmount }, billingMode: "monthly", resourceLimits: offer.resourceLimits,
    });
    expect(subscription).toEqual(before);
    expect(subscriptionOffer(tier, "monthly").reference).not.toBe(offer.reference);
    expect(() => subscriptionPlan(subscription, "org-b", "ns-a")).toThrow(/could not be verified/);
  });
  it.each(["9", "10", "11", "12", "13"])("rejects metered terms under a monthly v%s reference", version => {
    const subscription = monthlyPro();
    subscription.offer!.reference = `openship:pro:v${version}`;
    subscription.metadata!.openship_offer_version = version;
    subscription.offer!.billingMode = "payg";
    subscription.offer!.credits = 100;
    subscription.offer!.policy = { overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" };
    delete subscription.offer!.capacity;
    expect(() => subscriptionPlan(subscription, "org-a", "ns-a")).toThrow(/could not be verified/);
  });
  it("keeps a $5 monthly Hobby subscription at 2 GB RAM and 40 GB disk after the $10 offer launches", async () => {
    const offer = savedMonthlyHobby();
    const metadata = subscriptionMetadata("hobby", "org-a", "ns-a");
    metadata.openship_offer_version = "11";
    metadata.openship_limits = JSON.stringify({ ...JSON.parse(metadata.openship_limits!),
      maxServiceResources: { cpuCores: 1, memoryMb: 2048 } });
    const subscription = { ...savedPro(), offer, metadata };
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription, "org-a", "ns-a")).toMatchObject({
      resourceLimits: { max_total_vcpus: 1, max_total_ram_mb: 2048, max_total_disk_gb: 40 },
      limits: { maxServiceResources: { cpuCores: 1, memoryMb: 2048 } },
    });
    expect(await cloudPlan("hobby", subscription)).toMatchObject({
      price: { monthly: 500 },
      resourceLimits: { max_total_ram_mb: 2048, max_total_disk_gb: 40 },
    });
    expect(subscription).toEqual(before);
    expect(subscriptionOffer("hobby", "monthly")).toMatchObject({
      reference: "openship:hobby:v13", unitAmount: 1200,
      capacity: { vcpus: 1, memoryMb: 4096, diskGb: 50, workspaces: 1 },
    });
  });
  it("preserves an immutable custom-v2 purchase after annual quotes change their hash", async () => {
    // Captured from the pre-annual catalog and hash format, never regenerated at test time.
    const subscription = { ...savedPro(), offer: structuredClone(legacyCustom.offer),
      metadata: { ...subscriptionMetadata("starter", "org-a", "ns-a"), openship_offer_version: "custom-v2",
        openship_limits: JSON.stringify(legacyCustom.limits) } } as NonNullable<OblienSubscription>;
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription, "org-a", "ns-a")).toMatchObject({ tier: legacyCustom.tier, limits: legacyCustom.limits });
    expect(await cloudPlan("starter", subscription)).toMatchObject({ price: { monthly: legacyCustom.offer.unitAmount } });
    expect(subscription).toEqual(before);
    expect(() => subscriptionPlan({ ...subscription, billingInterval: "yearly" }, "org-a", "ns-a")).toThrow(/could not be verified/);
  });
  it("does not reinterpret a pre-annual preset as a paid annual contract", () => {
    const subscription = monthlyPro();
    subscription.offer!.reference = "openship:pro:v12";
    subscription.metadata!.openship_offer_version = "12";
    subscription.billingInterval = "yearly";
    expect(() => subscriptionPlan(subscription, "org-a", "ns-a")).toThrow(/could not be verified/);
  });
  it("a top-up only adds metered credits and cannot raise hardware limits or grace", () => {
    for (const pack of PRICING.creditPacks) {
      const offer = topupOffer(pack.id);
      expect(offer.credits * 1000).toBe(pack.creditsMilli);
      expect(offer.credits).toBeLessThanOrEqual(offer.unitAmount);
      expect(offer.resourceLimits).toBeUndefined(); expect(offer.policy).toBeUndefined();
      expect(offer.reference).toBe(`openship:${pack.id}:v3`);
    }
  });
  it("bounds legacy inherited capacity while preserving the customer's paid credits and price", async () => {
    const subscription = savedPro();
    subscription.offer = { ...subscription.offer!, reference: "openship:pro:v1", credits: 3000, unitAmount: 3900,
      resourceLimits: { max_workspaces: 1, max_vcpus: null, max_ram_mb: null, max_disk_gb: null } };
    subscription.metadata!.openship_offer_version = "1";
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription, "org-a", "ns-a").resourceLimits).toEqual({ max_workspaces: 1, max_vcpus: 2,
      max_ram_mb: 8192, max_disk_gb: 32, max_total_vcpus: 4, max_total_ram_mb: 8192, max_total_disk_gb: 128 });
    expect(await cloudPlan("pro", subscription)).toMatchObject({ price: { monthly: 3900 }, monthlyCredits: 3_000_000 });
    expect(subscription).toEqual(before);
  });
  it.each([
    ["pro", "pro", 2, 2048], ["team", "scale", 4, 8192],
  ] as const)("preserves pre-v4 inherited CPU ceilings for %s", (tier, providerTier, cpuCores, memoryMb) => {
    const subscription = savedPro();
    subscription.offer = { ...savedOffer(tier), reference: `openship:${tier}:v1`,
      resourceLimits: { max_workspaces: 1, max_vcpus: null, max_ram_mb: null, max_disk_gb: null } };
    subscription.metadata = { ...savedMetadata(tier, "org-a", "ns-a"), openship_offer_version: "1" };
    const limits = JSON.parse(subscription.metadata.openship_limits!);
    delete limits.maxServiceResources;
    subscription.metadata.openship_limits = JSON.stringify(limits);
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription).resourceLimits.max_vcpus).toBe(cpuCores);
    expect(planServiceResources(subscriptionPlan(subscription).limits)).toEqual({ cpuCores, memoryMb });
    expect(subscription).toEqual(before);

    subscription.offer.resourceLimits!.max_vcpus = 1;
    expect(subscriptionPlan(subscription).resourceLimits.max_vcpus).toBe(1);
    const inherited = subscriptionPlan({ ...subscription, tierId: providerTier });
    expect(inherited.resourceLimits.max_vcpus).toBe(cpuCores);
    expect(planServiceResources(inherited.limits)).toEqual({ cpuCores, memoryMb });
  });
  it("renewals retain the v2 paid snapshot when the public catalog changes", async () => {
    const subscription = savedPro();
    subscription.offer!.reference = "openship:pro:v2"; subscription.offer!.unitAmount = 3900;
    subscription.offer!.resourceLimits!.max_vcpus = 2; subscription.offer!.resourceLimits!.max_ram_mb = 6144;
    subscription.metadata!.openship_offer_version = "2";
    const before = structuredClone(subscription);
    const raw = PRICING.plans.find(plan => plan.id === "pro")!, old = structuredClone(raw);
    try {
      raw.billing.creditsPerCycle = 1000; raw.billing.resourceLimits.max_total_vcpus = 1; raw.price.monthly = 4900;
      expect(subscriptionPlan(subscription, "org-a", "ns-a").resourceLimits.max_total_vcpus).toBe(4);
      expect(await cloudPlan("pro", subscription)).toMatchObject({ price: { monthly: 3900 }, monthlyCredits: 3_500_000,
        resourceLimits: { max_vcpus: 2, max_total_vcpus: 4 } });
      expect(subscription).toEqual(before);
    } finally { Object.assign(raw, old); }
  });
  it("keeps v3 paid service limits, price, credits and capacity unchanged after new offers are published", async () => {
    const subscription: NonNullable<OblienSubscription> = {
      ...savedPro(),
      offer: { reference: "openship:pro:v3", name: "Openship Pro", currency: "usd", unitAmount: 4000, credits: 3500,
        policy: { overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" },
        resourceLimits: { max_workspaces: 1, max_vcpus: 2, max_ram_mb: 8192, max_disk_gb: 32,
          max_total_vcpus: 4, max_total_ram_mb: 8192, max_total_disk_gb: 128 } },
      metadata: { openship_plan: "pro", openship_offer_version: "3", openship_organization: "org-a", openship_namespace: "ns-a",
        openship_limits: JSON.stringify({ workloads: ["static", "web", "worker"], services: true, runningServices: 10,
          maxProjects: 50, maxResourceTier: "high", computeMinutesPerMonth: null, buildMinutesPerMonth: null,
          freeSubdomains: 100, customDomains: null, seats: null }) },
    };
    const before = structuredClone(subscription);
    const saved = subscriptionPlan(subscription, "org-a", "ns-a");
    expect(saved.limits).toEqual(JSON.parse(subscription.metadata!.openship_limits!));
    expect(saved.resourceLimits).toEqual(subscription.offer!.resourceLimits);
    expect(planServiceResources(saved.limits)).toEqual({ cpuCores: 2, memoryMb: 2048 });
    expect(planServiceResources(presentCloudPlans().plans.find(plan => plan.id === "pro")!.limits))
      .toEqual({ cpuCores: 4, memoryMb: 16384 });
    const displayed = await cloudPlan("pro", subscription);
    expect(displayed).toMatchObject({ price: { monthly: 4000 }, monthlyCredits: 3_500_000,
      limits: saved.limits, resourceLimits: subscription.offer!.resourceLimits });
    expect(subscription).toEqual(before);
  });
  it("retains Hobby v3 and pre-reseller Starter presets without applying the new RAM allowance", () => {
    const subscription = savedPro();
    subscription.offer = { ...savedOffer("hobby"), reference: "openship:hobby:v3" };
    subscription.metadata = { ...savedMetadata("hobby", "org-a", "ns-a"), openship_offer_version: "3" };
    const limits = JSON.parse(subscription.metadata.openship_limits!);
    delete limits.maxServiceResources;
    subscription.metadata.openship_limits = JSON.stringify(limits);
    expect(planServiceResources(subscriptionPlan(subscription).limits)).toEqual({ cpuCores: 0.5, memoryMb: 512 });
    expect(planServiceResources(subscriptionPlan({ ...subscription, tierId: "hobby" }).limits))
      .toEqual({ cpuCores: 1, memoryMb: 1024 });
  });
  it("preserves the $40 v4 Pro purchase after publishing the $39 offer", async () => {
    const subscription = savedPro();
    subscription.offer = { ...subscription.offer!, reference: "openship:pro:v4", unitAmount: 4000 };
    subscription.metadata!.openship_offer_version = "4";
    const before = structuredClone(subscription);
    const saved = subscriptionPlan(subscription, "org-a", "ns-a");
    expect(await cloudPlan("pro", subscription)).toMatchObject({ price: { monthly: 4000 }, monthlyCredits: 3_500_000,
      limits: saved.limits, resourceLimits: subscription.offer.resourceLimits });
    expect(subscriptionOffer("pro", "monthly")).toMatchObject({ reference: "openship:pro:v13", unitAmount: 4700, credits: 0, billingMode: "monthly",
      capacity: { vcpus: 4, memoryMb: 16384, diskGb: 250, workspaces: 1 } });
    expect(subscription).toEqual(before);
  });
  it.each(["4", "5", "6", "7"])("rejects unverifiable service ceilings in v%s", version => {
    for (const maxServiceResources of [null, undefined, { cpuCores: 0, memoryMb: 4096 }]) {
      const subscription = savedPro();
      subscription.offer!.reference = `openship:pro:v${version}`;
      subscription.metadata!.openship_offer_version = version;
      subscription.metadata!.openship_limits = JSON.stringify({ ...JSON.parse(subscription.metadata!.openship_limits!), maxServiceResources });
      expect(() => subscriptionPlan(subscription)).toThrow(/could not be verified/);
    }
  });
  it("rejects unknown versions and mismatched offer metadata", () => {
    const subscription = savedPro();
    subscription.metadata!.openship_offer_version = "3";
    expect(() => subscriptionPlan(subscription)).toThrow(/could not be verified/);
    subscription.metadata!.openship_offer_version = "99";
    subscription.offer!.reference = "openship:pro:v99";
    expect(() => subscriptionPlan(subscription)).toThrow(/could not be verified/);
  });
  it.each([undefined, null])("rejects an incomplete or unbounded new retail capacity contract (%s)", value => {
    const subscription = monthlyPro(); subscription.offer!.resourceLimits!.max_total_vcpus = value;
    expect(() => subscriptionPlan(subscription, "org-a", "ns-a")).toThrow(/could not be verified/);
  });
  it("rejects a subscription copied from another organization or namespace", () => {
    expect(() => subscriptionPlan(savedPro(), "org-b", "ns-a")).toThrow(/could not be verified/);
    expect(() => subscriptionPlan(savedPro(), "org-a", "ns-b")).toThrow(/could not be verified/);
  });
  it("preserves the paid v5 Hobby storage and credits", async () => {
    const offer = savedMonthlyHobby();
    expect(offer).toMatchObject({ reference: "openship:hobby:v11", unitAmount: 500, credits: 0, billingMode: "monthly",
      resourceLimits: { max_disk_gb: 40, max_total_disk_gb: 40 } });
    const subscription = { ...savedPro(), offer: savedOffer("hobby", "monthly"), metadata: savedMetadata("hobby", "org-a", "ns-a") };
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription, "org-a", "ns-a").resourceLimits).toMatchObject({ max_disk_gb: 16, max_total_disk_gb: 16 });
    expect(await cloudPlan("hobby", subscription)).toMatchObject({ price: { monthly: 500 }, monthlyCredits: 400_000,
      resourceLimits: { max_disk_gb: 16, max_total_disk_gb: 16 } });
    expect(subscription).toEqual(before);
  });
  it("keeps a v6 subscriber's purchased RAM and service ceiling after publishing full-workspace v7 offers", async () => {
    const subscription = { ...savedPro(),
      offer: { ...savedOffer("pro", "monthly"), reference: "openship:pro:v6" },
      metadata: { ...savedMetadata("pro", "org-a", "ns-a"), openship_offer_version: "6" },
    };
    const before = structuredClone(subscription);
    expect(await cloudPlan("pro", subscription)).toMatchObject({
      price: { monthly: 3900 }, monthlyCredits: 3_500_000,
      limits: { maxServiceResources: { cpuCores: 4, memoryMb: 4096 } },
      resourceLimits: { max_ram_mb: 8192, max_total_ram_mb: 8192, max_disk_gb: 32 },
    });
    expect(subscriptionOffer("pro", "monthly")).toMatchObject({ reference: "openship:pro:v13",
      resourceLimits: { max_ram_mb: 16384, max_total_ram_mb: 16384, max_disk_gb: 250 } });
    expect(subscription).toEqual(before);
  });
});
