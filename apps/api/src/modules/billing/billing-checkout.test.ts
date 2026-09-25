import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import { parseInput, CreateSubscriptionBody, CreateTopupBody } from "@repo/contracts";

const h = vi.hoisted(() => ({
  support: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
  subscription: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  namespace: vi.fn(),
  sync: vi.fn(),
  legacy: vi.fn(),
  quota: vi.fn(),
  env: { CLOUD_MODE: true, BILLING_ENABLED: true, BILLING_TOPUPS_ENABLED: true },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env, runtimeTarget: { dashboard: "https://app.openship.io" } }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ workspaces: { getQuota: h.quota } }),
  getOblienBillingApi: () => ({
    createCheckout: h.checkout,
    createPortal: h.portal,
    cancelSubscription: h.cancel,
    resumeSubscription: h.resume,
    getSubscription: h.subscription,
    assertResellerSupport: h.support,
  }),
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ ensureNamespace: h.namespace }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  syncOblienEntitlement: h.sync,
  withCloudBillingLock: async (orgId: string, work: (sync: (options: unknown) => Promise<unknown>) => Promise<unknown>) =>
    work((options: unknown) => h.sync(orgId, options)),
}));
vi.mock("@repo/platform/engine/modules/billing/billing.repository", () => ({ listLiveSubscriptions: h.legacy }));
import { createCheckoutSession, createTopupCheckoutSession, createPortalSession, cancelSubscription, resumeSubscription, listActiveCreditPacks } from "@repo/platform/engine/modules/billing/billing.service";
import { presentCloudPlans, subscriptionPlan } from "@repo/platform/engine/modules/billing/billing-catalog";

const ctx = (organizationId = "org-a") => ({ organizationId }) as never;
const subscription = {
  tierId: "hobby", status: "active", billingInterval: "yearly",
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2027-09-01T00:00:00Z",
  cancelAtPeriodEnd: false, canceledAt: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  h.env.BILLING_ENABLED = true;
  h.env.BILLING_TOPUPS_ENABLED = true;
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
  h.legacy.mockResolvedValue([]);
  h.support.mockResolvedValue(undefined);
  h.quota.mockResolvedValue({ success: true, limits: { cpus: 32, memory_mb: 65536, disk_size_mb: 1048576 }, maxSandboxes: null });
  h.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/test", checkoutId: "cs_test" });
  h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: null }));
  h.portal.mockResolvedValue({ url: "https://billing.stripe.com/p/session/test" });
  h.cancel.mockImplementation(async (namespace) => ({ success: true, namespace, subscription: { ...subscription, cancelAtPeriodEnd: true } }));
  h.resume.mockImplementation(async (namespace) => ({ success: true, namespace, subscription: { ...subscription } }));
});
describe("Cloud customer checkout", () => {
  it("does not create a paid checkout while a complimentary plan is active", async () => {
    h.sync.mockResolvedValueOnce({ grant: { id: "bpg-test" } });
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toMatchObject({ code: "BILLING_COMPLIMENTARY_PLAN" });
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("publishes Openship prices and separate namespace allowances", () => {
    const plans = presentCloudPlans().plans.filter(
      (plan) => !["free", "enterprise"].includes(plan.id),
    );
    expect(plans.map((plan) => [plan.id, plan.price.monthly, plan.monthlyCredits])).toEqual([
      ["starter", 1000, 1_200_000],
      ["pro", 3900, 3_000_000],
      ["team", 9900, 15_000_000],
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
        reference: "openship:starter:v1",
        unitAmount: 1000,
        credits: 1200,
        policy: { overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" },
        resourceLimits: { max_workspaces: 5 },
      },
      metadata: {
        openship_plan: "starter",
        openship_organization: "org-a",
        openship_namespace: "ns-org-a",
      },
    });
    expect(input.successUrl).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect(input).not.toHaveProperty("planTierId");
    expect(input).not.toHaveProperty("customer");
    expect(JSON.parse(input.metadata.openship_limits)).toMatchObject({
      runningServices: 3,
      maxProjects: 10,
    });
  });
  it("does not invent yearly prices or grants while annual checkout is disabled", async () => {
    await expect(createCheckoutSession(ctx(), "starter", "annual")).rejects.toMatchObject({
      code: "BILLING_PLAN_NOT_PURCHASABLE",
    });
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("submits the Team policy without calculating provider capacity or changing customer terms", async () => {
    h.quota.mockImplementation(() => { throw new Error("Client capacity reads are forbidden"); });
    await createCheckoutSession(ctx(), "team", "monthly", "team-attempt-001");
    const input = h.checkout.mock.calls[0]![0];
    expect(input.offer).toMatchObject({
      unitAmount: 9900, credits: 15000,
      resourceLimits: { max_workspaces: 52, max_vcpus: null, max_ram_mb: null, max_disk_gb: null },
    });
    expect(JSON.parse(input.metadata.openship_limits).runningServices).toBe(50);
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("passes a reseller's explicitly chosen VM restrictions unchanged", async () => {
    const plan = PRICING.plans.find(plan => plan.id === "starter")!;
    const saved = structuredClone(plan.billing.resourceLimits);
    try {
      plan.billing.resourceLimits = { max_workspaces: 7, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 24 };
      await createCheckoutSession(ctx(), "starter", "monthly");
      expect(h.checkout.mock.calls[0]![0].offer.resourceLimits).toEqual(plan.billing.resourceLimits);
      expect(h.quota).not.toHaveBeenCalled();
    } finally { plan.billing.resourceLimits = saved; }
  });
  it("uses explicit yearly credits and configurable grace when enabled by the reseller", async () => {
    const plan = PRICING.plans.find((plan) => plan.id === "starter")!;
    const before = structuredClone({ annual: PRICING.annual, plan });
    try {
      PRICING.annual.enabled = true;
      plan.price.annual = 10_000;
      plan.billing.yearlyCreditsPerCycle = 14_400;
      plan.billing.overdraft = 60;
      plan.billing.suspendThreshold = 60;
      await createCheckoutSession(ctx(), "starter", "annual", "annual-attempt-001");
      expect(h.checkout).toHaveBeenCalledWith(
        expect.objectContaining({
          billingInterval: "yearly",
          offer: expect.objectContaining({
            unitAmount: 10_000,
            credits: 14_400,
            policy: { overdraft: 60, suspendThreshold: 60, onOverdraftAction: "stop_workspaces" },
          }),
        }),
      );
    } finally {
      Object.assign(PRICING.annual, before.annual);
      Object.assign(plan, before.plan);
    }
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
    ]) {
      expect(() =>
        parseInput(CreateSubscriptionBody, {
          planTierId: "starter",
          interval: "monthly",
          [field]: "injected",
        }),
      ).toThrow();
      expect(() =>
        parseInput(CreateTopupBody, { packId: "pack_5k", [field]: "injected" }),
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
  it.each(["active", "canceled", "credit_exhausted"])("uses provider replacement checkout for an existing %s subscription", async (status) => {
    h.sync.mockResolvedValue({ tier: "pro", entitlement: { status, periodEnd: "2026-10-01T00:00:00Z" } });
    await expect(createCheckoutSession(ctx(), "team", "monthly")).resolves.toHaveProperty("checkoutUrl");
    expect(h.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns-org-a",
        offer: expect.objectContaining({ reference: "openship:team:v1", unitAmount: 9900 }),
        billingInterval: "monthly",
      }),
    );
  });
  it("blocks legacy Stripe accounts before creating a second provider subscription", async () => {
    h.legacy.mockResolvedValue([{ id: "old-subscription" }]);
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toMatchObject({ code: "BILLING_MIGRATION_REQUIRED" });
    expect(h.namespace).not.toHaveBeenCalled();
    expect(h.checkout).not.toHaveBeenCalled();
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
    await expect(createTopupCheckoutSession(ctx(), "pack_5k")).rejects.toThrow(
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
      { id: "pack_5k", credits_milli: 5_000_000, price_cents: 500 },
      { id: "pack_25k", credits_milli: 25_000_000, price_cents: 2000 },
      { id: "pack_100k", credits_milli: 100_000_000, price_cents: 7000 },
    ]);
    await createTopupCheckoutSession(ctx(), "pack_5k", "attempt-00000001");
    expect(h.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns-org-a",
        kind: "topup",
        offer: expect.objectContaining({ credits: 5000, unitAmount: 500 }),
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
    await expect(createTopupCheckoutSession(ctx(), "pack_5k")).rejects.toThrow("entitlement unavailable");
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("refuses purchases before checkout when the provider cannot preserve the offer's policy and limits", async () => {
    h.support.mockRejectedValue(new Error("Billing provider update required"));
    h.subscription.mockImplementation(async (namespace) => ({
      success: true,
      namespace,
      subscription,
    }));
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toThrow(
      "Billing provider update required",
    );
    await expect(createTopupCheckoutSession(ctx(), "pack_5k")).rejects.toThrow(
      "Billing provider update required",
    );
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it.each([null, "canceled", "past_due", "unpaid", "paused"])("does not sell unusable top-up credits to a customer with subscription %s", async status => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: status === null ? null : { ...subscription, status } }));
    await expect(createTopupCheckoutSession(ctx(), "pack_5k")).rejects.toMatchObject({
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
    await expect(createTopupCheckoutSession(ctx(), "pack_5k")).rejects.toMatchObject({
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
  it("keeps legacy billing behind migration for every management action", async () => {
    h.legacy.mockResolvedValue([{ id: "old-subscription" }]);
    for (const action of [createPortalSession, cancelSubscription, resumeSubscription]) {
      await expect(action("org-a")).rejects.toMatchObject({ code: "BILLING_MIGRATION_REQUIRED" });
    }
    expect(h.portal).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });
  it("does not report success when the provider has not changed renewal", async () => {
    h.cancel.mockResolvedValue({ subscription });
    h.resume.mockResolvedValue({ subscription: { ...subscription, cancelAtPeriodEnd: true } });
    await expect(cancelSubscription("org-a")).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    await expect(resumeSubscription("org-a")).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
});
