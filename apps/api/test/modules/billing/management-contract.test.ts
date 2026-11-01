import type { ManagementPlanId } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  managementOffer,
  managementServerLimit,
  paidManagement,
  managementCloudBenefitOffer,
} from "@repo/platform/engine/modules/billing/management-contract";
import { subscriptionPlan } from "@repo/platform/engine/modules/billing/billing-catalog";
import type {
  OblienEntitlement,
  OblienSubscription,
} from "@repo/platform/engine/lib/oblien-billing-api";
import { savedOffer, savedMetadata } from "../../helpers/saved-cloud-offer";

function cycle(servers = 2, cloud = false, plan: ManagementPlanId = "basic") {
  const terms = managementOffer("org_test", "os-manage-test", servers, cloud, plan);
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  const subscription: NonNullable<OblienSubscription> = {
    ...terms,
    tierId: "reseller",
    billingInterval: "monthly",
    status: "active",
    periodStart: start,
    periodEnd: end,
    cancelAtPeriodEnd: false,
  };
  const entitlement: OblienEntitlement = {
    namespace: "os-manage-test",
    tierId: "reseller",
    status: "active",
    billingMode: "service",
    computeCovered: false,
    serviceCovered: true,
    periodStart: start,
    periodEnd: end,
    quota: { limit: 0, used: 0, balance: 0, overdraft: 0, suspendThreshold: 0 },
  };
  return { subscription, entitlement, end };
}
const paid = (c: ReturnType<typeof cycle>) =>
  paidManagement("org_test", "os-manage-test", c.subscription, c.entitlement);

describe("Manage paid contracts", () => {
  it("prices the organization allowance and waives only the Cloud base, without granting compute", () => {
    expect(managementOffer("org", "ns", 2, false).offer).toMatchObject({
      unitAmount: 500,
      billingMode: "service",
      credits: 0,
    });
    expect(managementOffer("org", "ns", 5, false).offer.unitAmount).toBe(1400);
    expect(managementOffer("org", "ns", 5, true).offer.unitAmount).toBe(900);
    expect(() => managementOffer("org", "ns", 2, true)).toThrow(/already includes/);
    expect(() => managementOffer("org", "ns", 1, false)).toThrow();
  });
  it("keeps priority support paid and separate from included Basic management", () => {
    const priority = cycle(2, false, "priority");
    expect(priority.subscription.offer).toMatchObject({ unitAmount: 2000, billingMode: "service", credits: 0 });
    expect(paid(priority)).toMatchObject({ plan: "priority", servers: 2 });
    const included = managementCloudBenefitOffer("org_test", "os-manage-test", priority.subscription)!;
    expect(included.offer.unitAmount).toBe(1500);
    expect(JSON.parse(included.metadata.openship_management)).toMatchObject({ plan: "priority", baseIncluded: true, basePriceCents: 0, supportMonthlyCents: 1500 });
    expect(managementOffer("org", "ns", 5, false, "priority").offer.unitAmount).toBe(2900);
    expect(managementOffer("org", "ns", 2, true, "priority").offer.unitAmount).toBe(1500);
    expect(paid({ ...priority, entitlement: { ...priority.entitlement, serviceCovered: false } })).toBeNull();
    const basic = cycle();
    const metadata = JSON.parse(basic.subscription.metadata!.openship_management!);
    basic.subscription.metadata!.openship_management = JSON.stringify({ ...metadata, plan: "priority", supportMonthlyCents: 1500 });
    expect(() => paid(basic)).toThrow(/organization/);
  });
  it("continues verifying saved v1 Basic terms without rewriting the paid price", () => {
    const c = cycle();
    c.subscription.metadata!.openship_management = '{"version":1,"servers":2,"includedServers":2,"baseIncluded":false,"basePriceCents":500,"extraServerMonthlyCents":300}';
    c.subscription.offer!.reference = "openship:manage:v1:659c661c1cab2ac9661c491b";
    c.subscription.offer!.unitAmount = 500;
    const before = structuredClone(c.subscription);
    expect(paid(c)).toMatchObject({ plan: "basic", servers: 2, priceCents: 500 });
    expect(c.subscription).toEqual(before);
  });
  it("requires paid proof for this organization, namespace and exact cycle", () => {
    const c = cycle();
    expect(paid(c)?.servers).toBe(2);
    for (const patch of [
      { namespace: "other" },
      { periodEnd: new Date(Date.now() + 172800000).toISOString() },
      { computeCovered: true },
      { billingMode: "monthly" as const },
    ]) {
      expect(() => paid({ ...c, entitlement: { ...c.entitlement, ...patch } })).toThrow(/verified/);
    }
    expect(() =>
      paidManagement("foreign_org", "os-manage-test", c.subscription, c.entitlement),
    ).toThrow(/organization/);
    expect(paid({ ...c, entitlement: { ...c.entitlement, serviceCovered: false } })).toBeNull();
    expect(
      paidManagement(
        "org_test",
        "os-manage-test",
        c.subscription,
        c.entitlement,
        Date.parse(c.end) + 1,
      ),
    ).toBeNull();
  });
  it("honors the paid allowance through cancellation and loss of Cloud coverage", () => {
    const c = cycle(4, true);
    c.subscription.cancelAtPeriodEnd = true;
    const verified = paid(c)!;
    expect(managementServerLimit(verified, null)).toBe(4);
    expect(managementServerLimit(verified, null, Date.parse(c.end) + 1)).toBe(0);
    expect(managementServerLimit(null, new Date(c.end))).toBe(2);
  });
  it("rejects modified prices or terms and discounts existing extra servers at renewal", () => {
    const c = cycle(4);
    expect(
      managementCloudBenefitOffer("org_test", "os-manage-test", c.subscription)?.offer.unitAmount,
    ).toBe(600);
    c.subscription.offer!.unitAmount = 1;
    expect(() => paid(c)).toThrow(/organization/);
  });
  it("still reads the saved Hobby compute contract after new Hobby sales close", () => {
    const sub = {
      tierId: "reseller",
      status: "active",
      billingInterval: "monthly",
      periodStart: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      offer: savedOffer("hobby"),
      metadata: savedMetadata("hobby", "org_test", "ns_test"),
    } as NonNullable<OblienSubscription>;
    expect(subscriptionPlan(sub, "org_test", "ns_test").tier).toBe("hobby");
  });
});
