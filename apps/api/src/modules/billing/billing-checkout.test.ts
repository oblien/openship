import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OblienBillingCatalog } from "@repo/platform/engine/lib/oblien-billing-api";

const h = vi.hoisted(() => ({
  catalog: vi.fn(), checkout: vi.fn(), portal: vi.fn(), subscription: vi.fn(), cancel: vi.fn(), resume: vi.fn(), namespace: vi.fn(), sync: vi.fn(), legacy: vi.fn(),
  env: { CLOUD_MODE: true, BILLING_ENABLED: true, BILLING_TOPUPS_ENABLED: true },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env, runtimeTarget: { dashboard: "https://app.openship.io" } }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienBillingApi: () => ({
  createCheckout: h.checkout, createPortal: h.portal, cancelSubscription: h.cancel, resumeSubscription: h.resume,
  getSubscription: h.subscription,
}) }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ ensureNamespace: h.namespace }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ syncOblienEntitlement: h.sync }));
vi.mock("@repo/platform/engine/modules/billing/billing.repository", () => ({ listLiveSubscriptions: h.legacy }));
vi.mock("@repo/platform/engine/modules/billing/billing-catalog", async (original) => ({
  ...await original<typeof import("@repo/platform/engine/modules/billing/billing-catalog")>(), getCloudBillingCatalog: h.catalog,
}));
import { createCheckoutSession, createTopupCheckoutSession, createPortalSession, cancelSubscription, resumeSubscription, listActiveCreditPacks } from "@repo/platform/engine/modules/billing/billing.service";
import { presentCloudPlans } from "@repo/platform/engine/modules/billing/billing-catalog";

const catalog: OblienBillingCatalog = {
  success: true,
  plans: [
    { tierId: "hobby", name: "Hobby", description: "Hobby projects", priceMonthly: 10, priceYearly: 100, currency: "usd", creditsPerCycle: 1200, yearlyCreditsPerCycle: 14400, features: [] },
    { tierId: "pro", name: "Pro", priceMonthly: 29, priceYearly: 290, currency: "usd", creditsPerCycle: 3000, yearlyCreditsPerCycle: 36000, features: [] },
    { tierId: "scale", name: "Scale", priceMonthly: 149, priceYearly: 1490, currency: "usd", creditsPerCycle: 15000, yearlyCreditsPerCycle: 180000, features: [] },
    { tierId: "enterprise", name: "Enterprise", priceMonthly: null, priceYearly: null, currency: "usd", creditsPerCycle: null, yearlyCreditsPerCycle: null, features: [] },
  ],
  creditPacks: [{ packId: "starter", name: "Starter", credits: 1000, price: 10, currency: "usd" }],
};
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
  h.catalog.mockResolvedValue(structuredClone(catalog));
  h.namespace.mockImplementation(async (org) => `ns-${org}`);
  h.sync.mockResolvedValue({ tier: "free", entitlement: { status: "credit_exhausted", periodEnd: null } });
  h.legacy.mockResolvedValue([]);
  h.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/test", checkoutId: "cs_test" });
  h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: null }));
  h.portal.mockResolvedValue({ url: "https://billing.stripe.com/p/session/test" });
  h.cancel.mockImplementation(async (namespace) => ({ success: true, namespace, subscription: { ...subscription, cancelAtPeriodEnd: true } }));
  h.resume.mockImplementation(async (namespace) => ({ success: true, namespace, subscription: { ...subscription } }));
});
describe("Cloud customer checkout", () => {
  it("uses provider prices and credits consistently across catalog and checkout aliases", () => {
    const plans = presentCloudPlans(catalog).plans;
    expect(plans.map((plan) => [plan.id, plan.name, plan.price.monthly])).toEqual([
      ["starter", "Hobby", 1000], ["pro", "Pro", 2900], ["team", "Scale", 14900], ["enterprise", "Enterprise", null],
    ]);
    expect(plans[0]?.monthlyCredits).toBe(1_200_000);
    expect(plans.every((plan) => plan.campaign === null && plan.limits.computeMinutesPerMonth === null)).toBe(true);
  });
  it("starts the yearly provider plan for the authenticated customer's namespace", async () => {
    await createCheckoutSession(ctx(), "starter", "annual", "attempt-00000001");
    expect(h.checkout).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "ns-org-a", kind: "subscription", planTierId: "hobby", billingInterval: "yearly",
      successUrl: "https://app.openship.io/billing/overview?checkout=success&tier=starter&interval=annual",
    }));
    expect(h.checkout.mock.calls[0]![0]).not.toHaveProperty("price");
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
    expect(h.checkout).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns-org-a", planTierId: "scale", billingInterval: "monthly" }));
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
    // Subscription checkout verifies this through the shared entitlement read;
    // top-ups check the namespace subscription directly.
    h.sync.mockRejectedValue(new Error("subscription API unavailable"));
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toThrow("subscription API unavailable");
    await expect(createTopupCheckoutSession(ctx(), "starter")).rejects.toThrow("subscription API unavailable");
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("purchases provider credit packs using the same public catalog", async () => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription }));
    expect(await listActiveCreditPacks()).toMatchObject([{ id: "starter", credits_milli: 1_000_000, price_cents: 1000 }]);
    await createTopupCheckoutSession(ctx(), "starter", "attempt-00000001");
    expect(h.checkout).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns-org-a", kind: "topup", packId: "starter" }));
    await expect(createTopupCheckoutSession(ctx(), "removed-pack")).rejects.toMatchObject({ code: "BILLING_PACK_NOT_FOUND" });
    expect(h.checkout).toHaveBeenCalledOnce();
  });
  it.each([null, "canceled", "past_due", "unpaid", "paused"])("does not sell unusable top-up credits to a customer with subscription %s", async status => {
    h.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: status === null ? null : { ...subscription, status } }));
    await expect(createTopupCheckoutSession(ctx(), "starter")).rejects.toMatchObject({ code: "CLOUD_PLAN_REQUIRED", statusCode: 402 });
    expect(h.checkout).not.toHaveBeenCalled();
  });
  it("honors both purchase switches", async () => {
    h.env.BILLING_ENABLED = false;
    await expect(createCheckoutSession(ctx(), "pro", "monthly")).rejects.toMatchObject({ code: "BILLING_NOT_ENABLED" });
    h.env.BILLING_ENABLED = true;
    h.env.BILLING_TOPUPS_ENABLED = false;
    await expect(createTopupCheckoutSession(ctx(), "starter")).rejects.toMatchObject({ code: "BILLING_TOPUPS_NOT_ENABLED" });
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
