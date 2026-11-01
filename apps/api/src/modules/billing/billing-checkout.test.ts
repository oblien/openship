import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import { parseInput, CreateSubscriptionBody, CreateTopupBody } from "@repo/contracts";

const h = vi.hoisted(() => ({
  support: vi.fn(),
  monthlySupport: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
  subscription: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  namespace: vi.fn(),
  sync: vi.fn(),
  quota: vi.fn(),
  pending: new Map<string, unknown[]>(),
  members: vi.fn(),
  env: { CLOUD_MODE: true, BILLING_ENABLED: true, BILLING_TOPUPS_ENABLED: true, AFFILIATES_ENABLED: false, OBLIEN_AFFILIATE_NAMESPACE: "openship" },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env, runtimeTarget: { dashboard: "https://app.openship.io" } }));
vi.mock("@repo/db", () => {
  const workspace = (organizationId: string) => ({
    id: `workspace-${organizationId}`, organizationId, namespace: `ns-${organizationId}`,
    pendingCheckouts: h.pending.get(organizationId) ?? [],
  });
  return { repos: {
    organization: { findById: async (id: string) => ({ id }) },
    member: { listByOrganization: h.members },
    cloudWorkspace: {
      listByOrganization: async (org: string) => [workspace(org)],
      findByIdInOrganization: async (id: string, org: string) => id === workspace(org).id ? workspace(org) : undefined,
      setPendingCheckouts: async (_id: string, org: string, value: unknown[]) => { h.pending.set(org, value); },
    },
  } };
});
vi.mock("@repo/platform/engine/lib/cloud-workspace-host", () => ({
  readCloudWorkspaceHost: async () => ({ provider: null }),
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ workspaces: { getQuota: h.quota } }),
  getOblienBillingApi: () => ({
    createCheckout: h.checkout,
    createPortal: h.portal,
    cancelSubscription: h.cancel,
    resumeSubscription: h.resume,
    getSubscription: h.subscription,
    getCheckout: async () => ({ checkout: { status: "open", fulfilled: false } }),
    assertResellerSupport: h.support,
    assertMonthlyCapacitySupport: h.monthlySupport,
  }),
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ ensureNamespace: h.namespace }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  syncOblienEntitlement: h.sync,
  withCloudBillingLock: async (orgId: string, work: (sync: (options: unknown) => Promise<unknown>) => Promise<unknown>) =>
    work((options: unknown) => h.sync(orgId, options)),
}));
import { createCheckoutSession, createTopupCheckoutSession, createPortalSession, cancelSubscription, resumeSubscription, listActiveCreditPacks } from "@repo/platform/engine/modules/billing/billing.service";
import { customSubscriptionOffer, validCustomOffer } from "@repo/platform/engine/modules/billing/billing-custom-offer";
import { presentCloudPlans, subscriptionPlan } from "@repo/platform/engine/modules/billing/billing-catalog";
import { affiliateParticipantKey } from "@repo/platform/engine/modules/affiliates/affiliate-provider";

const ctx = (organizationId = "org-a") => ({ organizationId }) as never;
const subscription = {
  tierId: "hobby", status: "active" as const, billingInterval: "yearly" as const,
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2027-09-01T00:00:00Z",
  cancelAtPeriodEnd: false, canceledAt: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  h.pending.clear();
  h.env.BILLING_ENABLED = true;
  h.env.BILLING_TOPUPS_ENABLED = true;
  h.env.AFFILIATES_ENABLED = false;
  h.members.mockResolvedValue([{ userId: "owner" }, { userId: "buyer" }]);
  h.namespace.mockImplementation(async (org) => `ns-${org}`);
  h.sync.mockImplementation(async (orgId) => {
    const namespace = `ns-${orgId}`;
    const { subscription: current } = await h.subscription(namespace);
    return {
      ...subscriptionPlan(current, orgId, namespace),
      subscription: current,
      entitlement: { status: current ? "active" : "credit_exhausted", periodEnd: current?.periodEnd ?? null },
    };
  });
  h.support.mockResolvedValue(undefined);
  h.monthlySupport.mockResolvedValue({});
  h.quota.mockResolvedValue({ success: true, limits: { cpus: 32, memory_mb: 65536, disk_size_mb: 1048576 }, maxSandboxes: null });
  h.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/test", checkoutId: "cs_test" });
  h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: null }));
  h.portal.mockResolvedValue({ url: "https://billing.stripe.com/p/session/test" });
  h.cancel.mockImplementation(async (namespace) => ({ success: true, namespace, subscription: { ...subscription, cancelAtPeriodEnd: true } }));
  h.resume.mockImplementation(async (namespace) => ({ success: true, namespace, subscription: { ...subscription } }));
});
describe("Cloud customer checkout", () => {
  it.each(["monthly", "annual"] as const)("binds verified buyer and workspace members to the normal %s referral checkout", async interval => {
    h.env.AFFILIATES_ENABLED = true;
    await createCheckoutSession({ organizationId: "org-a", userId: "buyer" } as never, "starter", interval,
      "affiliate-attempt-0001", undefined, undefined, "AF-0123456789");
    expect(h.members).toHaveBeenCalledWith("org-a");
    expect(h.checkout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      namespace: "ns-org-a", kind: "subscription", billingInterval: interval === "annual" ? "yearly" : "monthly",
      affiliateCode: "AF-0123456789", affiliateBuyer: { namespace: "openship", buyerKey: affiliateParticipantKey("buyer"),
        relatedKeys: [affiliateParticipantKey("owner"), affiliateParticipantKey("buyer")] },
    }));
    expect(h.pending.get("org-a")).toHaveLength(1);
  });
  it("saves buyer identity for later hosted code entry but rejects codes when the feature is disabled", async () => {
    await expect(createCheckoutSession(ctx(), "starter", "monthly", "affiliate-disabled", undefined, undefined, "AF-0123456789"))
      .rejects.toMatchObject({ code: "AFFILIATE_INELIGIBLE" });
    expect(h.checkout).not.toHaveBeenCalled(); expect(h.members).not.toHaveBeenCalled();
    h.env.AFFILIATES_ENABLED = true;
    await createCheckoutSession({ organizationId: "org-a", userId: "buyer" } as never, "starter", "monthly", "affiliate-hosted-entry");
    expect(h.checkout.mock.calls[0]![0]).toHaveProperty("affiliateBuyer.buyerKey", affiliateParticipantKey("buyer"));
    expect(h.checkout.mock.calls[0]![0]).not.toHaveProperty("affiliateCode");
  });
  it("does not create a paid checkout while a complimentary plan is active", async () => {
    h.sync.mockResolvedValueOnce({ grant: { id: "bpg-test" } });
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toMatchObject({ code: "BILLING_COMPLIMENTARY_PLAN" });
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("publishes the approved retail prices with no monthly credit allowance", () => {
    const plans = presentCloudPlans().plans.filter(
      (plan) => !["free", "enterprise"].includes(plan.id),
    );
    expect(plans.map((plan) => [plan.id, plan.price.monthly, plan.monthlyCredits])).toEqual([
      ["hobby", 1200, null],
      ["starter", 2400, null],
      ["pro", 4700, null],
      ["team", 11900, null],
    ]);
    expect(presentCloudPlans().annual.enabled).toBe(false);
  });
  it("starts an Openship offer bound to the authenticated organization", async () => {
    await createCheckoutSession(ctx(), "starter", "monthly", "attempt-00000001");
    const input = h.checkout.mock.calls[0]![0];
    expect(input).toMatchObject({
      namespace: "ns-org-a",
      kind: "subscription",
      billingInterval: "monthly",
      offer: {
        reference: "openship:starter:v13",
        unitAmount: 2400,
        credits: 0, billingMode: "monthly",
        capacity: { vcpus: 2, memoryMb: 8192, diskGb: 128, workspaces: 1 },
        resourceLimits: { max_workspaces: 1, max_disk_gb: 128, max_total_vcpus: 2, max_total_ram_mb: 8192, max_total_disk_gb: 128 },
      },
      metadata: {
        openship_plan: "starter",
        openship_organization: "org-a",
        openship_namespace: "ns-org-a",
      },
    });
    expect(input.successUrl).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect(input.offer).not.toHaveProperty("policy");
    expect(input).not.toHaveProperty("planTierId");
    expect(input).not.toHaveProperty("customer");
    expect(JSON.parse(input.metadata.openship_limits)).toMatchObject({
      runningServices: 15,
      maxProjects: 10,
      concurrentBuilds: 4,
    });
  });
  it("checks out the $12 entry plan with the exact advertised capacity", async () => {
    await createCheckoutSession(ctx(), "hobby", "monthly", "hobby-attempt-001");
    expect(h.checkout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      namespace: "ns-org-a",
      offer: expect.objectContaining({
        reference: "openship:hobby:v13", unitAmount: 1200, billingMode: "monthly", credits: 0,
        capacity: { vcpus: 1, memoryMb: 4096, diskGb: 50, workspaces: 1 },
        resourceLimits: { max_workspaces: 1, max_vcpus: 1, max_total_vcpus: 1,
          max_ram_mb: 4096, max_total_ram_mb: 4096, max_disk_gb: 50, max_total_disk_gb: 50 },
      }),
    }));
  });
  it("refuses a retired offer before creating a checkout", async () => {
    const plan = PRICING.plans.find(plan => plan.id === "hobby")!;
    const previous = plan.availableForPurchase;
    try {
      plan.availableForPurchase = false;
      await expect(createCheckoutSession(ctx(), "hobby", "monthly", "hobby-attempt-001")).rejects.toMatchObject({ code: "BILLING_PLAN_RETIRED" });
      expect(h.checkout).not.toHaveBeenCalled();
    } finally {
      plan.availableForPurchase = previous;
    }
  });
  it("keeps an old provider Hobby subscription mapped to its original Openship Starter tier", () => {
    expect(subscriptionPlan(subscription, "org-a", "ns-org-a").tier).toBe("starter");
  });
  it.each([["hobby", 12000], ["starter", 24000], ["pro", 46800], ["team", 118800]] as const)(
    "charges the full year for %s without creating a compute-credit allowance", async (tier, unitAmount) => {
      await createCheckoutSession(ctx(), tier, "annual", `annual-${tier}-checkout`);
      expect(h.monthlySupport).toHaveBeenCalledWith("yearly");
      expect(h.checkout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        namespace: "ns-org-a", kind: "subscription", billingInterval: "yearly",
        offer: expect.objectContaining({ reference: `openship:${tier}:v13`, unitAmount, credits: 0, billingMode: "monthly" }),
        metadata: expect.objectContaining({ openship_organization: "org-a", openship_namespace: "ns-org-a" }),
      }));
    },
  );
  it("blocks annual checkout when the provider has not enabled annual capacity", async () => {
    h.monthlySupport.mockRejectedValueOnce(Object.assign(new Error("Annual purchases unavailable"), { code: "OBLIEN_CAPACITY_UNAVAILABLE" }));
    await expect(createCheckoutSession(ctx(), "starter", "annual")).rejects.toMatchObject({ code: "OBLIEN_CAPACITY_UNAVAILABLE" });
    expect(h.checkout).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });
  it("binds a custom quote to its billing interval before opening checkout", async () => {
    const resources = { cpuCores: 1, memoryMb: 4096, diskGb: 50 };
    const monthly = customSubscriptionOffer(resources), annual = customSubscriptionOffer(resources, "annual");
    expect(annual.quote).toMatchObject({ interval: "annual", priceCents: 12000 });
    expect(monthly.quote.reference).not.toBe(annual.quote.reference);
    expect(validCustomOffer(annual.quote.basePlanTierId, annual.limits, annual.offer, "annual")).toBe(true);
    expect(validCustomOffer(annual.quote.basePlanTierId, annual.limits, annual.offer, "monthly")).toBe(false);
    await expect(createCheckoutSession(ctx(), monthly.quote.basePlanTierId, "annual", "custom-wrong-interval", undefined,
      { resources, quoteReference: monthly.quote.reference })).rejects.toMatchObject({ code: "BILLING_QUOTE_CHANGED" });
    expect(h.checkout).not.toHaveBeenCalled();
    await createCheckoutSession(ctx(), annual.quote.basePlanTierId, "annual", "custom-annual-correct", undefined,
      { resources, quoteReference: annual.quote.reference });
    expect(h.checkout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      billingInterval: "yearly", offer: expect.objectContaining({ reference: annual.quote.reference, unitAmount: 12000, credits: 0 }),
    }));
  });
  it("submits the Scale pool without calculating provider prices or changing customer terms", async () => {
    h.quota.mockImplementation(() => { throw new Error("Client capacity reads are forbidden"); });
    await createCheckoutSession(ctx(), "team", "monthly", "team-attempt-001");
    const input = h.checkout.mock.calls[0]![0];
    expect(input.offer).toMatchObject({
      unitAmount: 11900, credits: 0, billingMode: "monthly",
      capacity: { vcpus: 8, memoryMb: 32768, diskGb: 600, workspaces: 1 },
      resourceLimits: { max_workspaces: 1, max_vcpus: 8, max_ram_mb: 32768, max_disk_gb: 600, max_total_vcpus: 8, max_total_ram_mb: 32768, max_total_disk_gb: 600 },
    });
    expect(JSON.parse(input.metadata.openship_limits).runningServices).toBe(100);
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("passes a reseller's explicitly chosen VM restrictions unchanged", async () => {
    const plan = PRICING.plans.find(plan => plan.id === "starter")!;
    const saved = structuredClone(plan.billing.resourceLimits);
    try {
      plan.billing.resourceLimits = { ...saved, max_workspaces: 7, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 24 };
      await createCheckoutSession(ctx(), "starter", "monthly");
      expect(h.checkout.mock.calls[0]![0].offer.resourceLimits).toEqual(plan.billing.resourceLimits);
      expect(h.quota).not.toHaveBeenCalled();
    } finally { plan.billing.resourceLimits = saved; }
  });
  it("cannot sell a monthly pool through the old yearly credit checkout", async () => {
    const plan = PRICING.plans.find(plan => plan.id === "starter")!;
    const before = structuredClone({ annual: PRICING.annual, plan });
    try {
      PRICING.annual.enabled = true;
      plan.price.annual = 10_000;
      plan.billing.yearlyCreditsPerCycle = 8_000;
      await expect(createCheckoutSession(ctx(), "starter", "annual", "annual-attempt-001"))
        .rejects.toMatchObject({ code: "BILLING_PLAN_NOT_PURCHASABLE" });
      expect(h.checkout).not.toHaveBeenCalled();
    } finally {
      Object.assign(PRICING.annual, before.annual);
      Object.assign(plan, before.plan);
    }
  });
  it("does not start a purchase when monthly capacity is unavailable at the provider", async () => {
    h.monthlySupport.mockRejectedValue(new Error("Monthly purchases unavailable"));
    await expect(createCheckoutSession(ctx(), "starter", "monthly")).rejects.toThrow("Monthly purchases unavailable");
    expect(h.checkout).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });
  it("does not start a competing checkout when the customer selects another plan", async () => {
    await createCheckoutSession(ctx(), "starter", "monthly", "attempt-starter-001");
    await expect(createCheckoutSession(ctx(), "pro", "monthly", "attempt-pro-001"))
      .rejects.toMatchObject({ code: "CLOUD_WORKSPACE_CHECKOUT_PENDING" });
    expect(h.checkout).toHaveBeenCalledOnce();
  });
  it("rejects customer-supplied price, credit, namespace and payment-customer overrides", () => {
    for (const field of [
      "namespace",
      "offer",
      "metadata",
      "customer",
      "unitAmount",
      "credits",
      "resourceLimits",
      "billingMode",
      "capacity",
      "computeCovered",
      "tariffId",
    ]) {
      expect(() =>
        parseInput(CreateSubscriptionBody, {
          planTierId: "starter",
          interval: "monthly",
          [field]: "injected",
        }),
      ).toThrow();
      expect(() =>
        parseInput(CreateTopupBody, { packId: "pack_4500", [field]: "injected" }),
      ).toThrow();
    }
  });
  it("reuses a retry key within one customer and isolates the same key across customers", async () => {
    await createCheckoutSession(ctx(), "pro", "monthly", "attempt-00000001");
    await createCheckoutSession(ctx(), "pro", "monthly", "attempt-00000001");
    await createCheckoutSession(ctx("org-b"), "pro", "monthly", "attempt-00000001");
    const keys = h.checkout.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });
  it.each(["active", "trialing", "past_due", "unpaid", "paused"])("preserves an existing %s subscription instead of charging for a full-price replacement", async (status) => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: { ...subscription, status } }));
    await expect(createCheckoutSession(ctx(), "team", "monthly")).rejects.toMatchObject({ code: "BILLING_PLAN_CHANGE_UNAVAILABLE" });
    expect(h.checkout).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
  });
  it("does not replace a subscription that is scheduled to cancel at renewal", async () => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: { ...subscription, cancelAtPeriodEnd: true } }));
    await expect(createCheckoutSession(ctx(), "starter", "monthly")).rejects.toMatchObject({ code: "BILLING_PLAN_CHANGE_UNAVAILABLE" });
    expect(h.checkout).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });
  it("allows a new subscription after the provider confirms the previous contract ended", async () => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: { ...subscription, status: "canceled" } }));
    await expect(createCheckoutSession(ctx(), "team", "monthly")).resolves.toHaveProperty("checkoutUrl");
    expect(h.checkout).toHaveBeenCalledOnce();
  });
  it("rechecks the provider contract when a checkout is retried after activation", async () => {
    await createCheckoutSession(ctx(), "starter", "monthly", "attempt-00000001");
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription }));
    await expect(createCheckoutSession(ctx(), "starter", "monthly", "attempt-00000001")).rejects.toMatchObject({ code: "BILLING_PLAN_CHANGE_UNAVAILABLE" });
    expect(h.checkout).toHaveBeenCalledOnce();
  });
  it("does not send a customer to checkout when entitlement cannot be verified", async () => {
    h.sync.mockRejectedValue(new Error("provider unavailable"));
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toThrow("provider unavailable");
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("blocks purchases through a provider deployment without the namespace billing contract", async () => {
    h.subscription.mockRejectedValue(new Error("subscription API unavailable"));
    // Both purchase kinds verify the namespace through the shared entitlement read.
    h.sync.mockRejectedValue(new Error("subscription API unavailable"));
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toThrow("subscription API unavailable");
    await expect(createTopupCheckoutSession(ctx(), "pack_4500")).rejects.toThrow(
      "subscription API unavailable",
    );
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("purchases reseller credit packs from Openship pricing", async () => {
    h.subscription.mockImplementation(async (namespace) => ({
      success: true,
      namespace,
      subscription,
    }));
    expect(await listActiveCreditPacks()).toMatchObject([
      { id: "pack_400", credits_milli: 400_000, price_cents: 500 },
      { id: "pack_1700", credits_milli: 1_700_000, price_cents: 2000 },
      { id: "pack_4500", credits_milli: 4_500_000, price_cents: 5000 },
    ]);
    await createTopupCheckoutSession(ctx(), "pack_4500", "attempt-00000001");
    expect(h.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns-org-a",
        kind: "topup",
        offer: expect.objectContaining({ credits: 4500, unitAmount: 5000 }),
      }),
    );
    await expect(createTopupCheckoutSession(ctx(), "removed-pack")).rejects.toMatchObject({
      code: "BILLING_PACK_NOT_FOUND",
    });
    expect(h.checkout).toHaveBeenCalledOnce();
  });
  it("does not sell top-ups when current entitlement cannot be verified", async () => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription }));
    h.sync.mockRejectedValue(new Error("entitlement unavailable"));
    await expect(createTopupCheckoutSession(ctx(), "pack_4500")).rejects.toThrow("entitlement unavailable");
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("refuses purchases before checkout when the provider cannot preserve the offer's policy and limits", async () => {
    h.support.mockRejectedValue(new Error("Billing provider update required"));
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toThrow(
      "Billing provider update required",
    );
    h.subscription.mockImplementation(async (namespace) => ({
      success: true,
      namespace,
      subscription,
    }));
    await expect(createTopupCheckoutSession(ctx(), "pack_4500")).rejects.toThrow(
      "Billing provider update required",
    );
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it.each([null, "canceled", "past_due", "unpaid", "paused"])("does not sell unusable top-up credits to a customer with subscription %s", async status => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: status === null ? null : { ...subscription, status } }));
    await expect(createTopupCheckoutSession(ctx(), "pack_4500")).rejects.toMatchObject({
      code: "CLOUD_PLAN_REQUIRED",
      statusCode: 402,
    });
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("honors both purchase switches", async () => {
    h.env.BILLING_ENABLED = false;
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toMatchObject({ code: "BILLING_NOT_ENABLED" });
    h.env.BILLING_ENABLED = true;
    h.env.BILLING_TOPUPS_ENABLED = false;
    await expect(createTopupCheckoutSession(ctx(), "pack_4500")).rejects.toMatchObject({
      code: "BILLING_TOPUPS_NOT_ENABLED",
    });
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("opens a separate customer portal for each trusted organization", async () => {
    for (const org of ["org-a", "org-b"]) {
      expect(await createPortalSession(org)).toEqual({ portalUrl: "https://billing.stripe.com/p/session/test" });
      expect(h.portal).toHaveBeenLastCalledWith({ namespace: `ns-${org}`, returnUrl: "https://app.openship.io/billing/overview" });
    }
  });
  it("stops renewal at the paid period end and can resume without granting credits", async () => {
    const canceled = await cancelSubscription("org-a");
    expect(canceled).toMatchObject({ cancelAt: subscription.periodEnd, subscription: { tier: "starter", interval: "annual", status: "active", cancelAtPeriodEnd: true } });
    expect(await cancelSubscription("org-a")).toEqual(canceled);
    expect(await resumeSubscription("org-a")).toMatchObject({ subscription: { cancelAtPeriodEnd: false, currentPeriod: { end: subscription.periodEnd } } });
    expect(h.cancel).toHaveBeenCalledWith("ns-org-a");
    expect(h.resume).toHaveBeenCalledWith("ns-org-a");
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("keeps billing management available while new purchases are disabled", async () => {
    h.env.BILLING_ENABLED = false;
    await createPortalSession("org-a");
    await cancelSubscription("org-a");
    await resumeSubscription("org-a");
    expect(h.portal).toHaveBeenCalledOnce();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.resume).toHaveBeenCalledOnce();
  });
  it("keeps existing subscriptions manageable while the provider needs an offer update", async () => {
    h.support.mockRejectedValue(new Error("Billing provider update required"));
    await createPortalSession("org-a");
    await cancelSubscription("org-a");
    await resumeSubscription("org-a");
    expect(h.portal).toHaveBeenCalledOnce();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.resume).toHaveBeenCalledOnce();
    expect(h.support).not.toHaveBeenCalled();
  });
  it("does not report success when the provider has not changed renewal", async () => {
    h.cancel.mockResolvedValue({ subscription });
    h.resume.mockResolvedValue({ subscription: { ...subscription, cancelAtPeriodEnd: true } });
    await expect(cancelSubscription("org-a")).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    await expect(resumeSubscription("org-a")).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
});
