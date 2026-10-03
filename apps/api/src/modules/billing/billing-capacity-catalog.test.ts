import { describe, expect, it, vi } from "vitest";
import { PRICING, planServiceResources } from "@repo/core";
import { BillingPlansSchema } from "@repo/contracts";
import { Value } from "@sinclair/typebox/value";
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient() { throw new Error("Capacity must be provider-enforced, not computed from owner resources"); } }));
import { cloudPlan, presentCloudPlans, subscriptionMetadata, subscriptionOffer, subscriptionPlan, topupOffer } from "@repo/platform/engine/modules/billing/billing-catalog";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
import { savedOffer, savedMetadata } from "../../../test/helpers/saved-cloud-offer";

const savedPro = (): NonNullable<OblienSubscription> => ({ tierId: "reseller", status: "active", billingInterval: "monthly",
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", cancelAtPeriodEnd: false, canceledAt: null,
  offer: subscriptionOffer("pro", "monthly"), metadata: subscriptionMetadata("pro", "org-a", "ns-a") });

describe("funded Cloud offers and isolated capacity", () => {
  it("keeps every retail allowance within wallet funding and finite hardware limits", () => {
    for (const tier of ["hobby", "starter", "pro", "team"] as const) {
      const offer = subscriptionOffer(tier, "monthly");
      expect(offer.credits).toBeLessThanOrEqual(offer.unitAmount);
      expect(Object.values(offer.resourceLimits!).every(value => Number.isInteger(value) && value! > 0)).toBe(true);
      expect(offer.policy).toMatchObject({ overdraft: 0, suspendThreshold: 0 });
      expect(presentCloudPlans().plans.find(plan => plan.id === tier)?.resourceLimits).toEqual(offer.resourceLimits);
      expect(offer.reference).toBe(`openship:${tier}:v8`);
      const saved = subscriptionPlan({ ...savedPro(), offer, metadata: subscriptionMetadata(tier, "org-a", "ns-a") });
      const published = presentCloudPlans().plans.find(plan => plan.id === tier)!;
      expect(planServiceResources(saved.limits)).toEqual(planServiceResources(published.limits));
    }
    expect(Value.Check(BillingPlansSchema, presentCloudPlans())).toBe(true);
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
    subscription.offer = { ...subscriptionOffer(tier, "monthly"), reference: `openship:${tier}:v1`,
      resourceLimits: { max_workspaces: 1, max_vcpus: null, max_ram_mb: null, max_disk_gb: null } };
    subscription.metadata = { ...subscriptionMetadata(tier, "org-a", "ns-a"), openship_offer_version: "1" };
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
    subscription.offer = { ...subscriptionOffer("hobby", "monthly"), reference: "openship:hobby:v3" };
    subscription.metadata = { ...subscriptionMetadata("hobby", "org-a", "ns-a"), openship_offer_version: "3" };
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
    expect(subscriptionOffer("pro", "monthly")).toMatchObject({ reference: "openship:pro:v8", unitAmount: 3900, credits: 3500,
      resourceLimits: saved.resourceLimits });
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
    const subscription = savedPro(); subscription.offer!.resourceLimits!.max_total_vcpus = value;
    expect(() => subscriptionPlan(subscription, "org-a", "ns-a")).toThrow(/could not be verified/);
  });
  it("rejects a subscription copied from another organization or namespace", () => {
    expect(() => subscriptionPlan(savedPro(), "org-b", "ns-a")).toThrow(/could not be verified/);
    expect(() => subscriptionPlan(savedPro(), "org-a", "ns-b")).toThrow(/could not be verified/);
  });
  it("publishes Hobby with 25 GB while preserving the paid v5 storage and credits", async () => {
    const offer = subscriptionOffer("hobby", "monthly");
    expect(offer).toMatchObject({ reference: "openship:hobby:v8", unitAmount: 500, credits: 400,
      resourceLimits: { max_disk_gb: 25, max_total_disk_gb: 25 } });
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
    expect(subscriptionOffer("pro", "monthly")).toMatchObject({ reference: "openship:pro:v8",
      resourceLimits: { max_ram_mb: 16384, max_total_ram_mb: 16384, max_disk_gb: 128 } });
    expect(subscription).toEqual(before);
  });
});
