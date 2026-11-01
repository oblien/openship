import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  payment: vi.fn(),
  subscription: vi.fn(),
  recheck: vi.fn(),
  enabled: vi.fn(() => true),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {},
  runtimeTarget: { dashboard: "https://app.openship.io" },
}));
vi.mock("@repo/platform/engine/modules/cloud-analytics/index", () => ({
  cloudAnalytics: { payment: h.payment, subscription: h.subscription, enabled: h.enabled },
}));
vi.mock("@repo/db", () => ({ repos: { cloudAnalytics: { recheckCheckout: h.recheck } } }));
import { resolveCloudAnalyticsConfig } from "@repo/platform/engine/modules/cloud-analytics/config";
import {
  observeCloudSubscription,
  observeVerifiedBillingEvent,
} from "@repo/platform/engine/modules/cloud-analytics/billing";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";

const environment = {
  CLOUD_MODE: true,
  NODE_ENV: "production",
  DEPLOY_MODE: "cloud",
  POSTHOG_ENABLED: true,
  POSTHOG_PROJECT_KEY: "phc_test",
  POSTHOG_HOST: "https://eu.i.posthog.com",
};
const url = "https://app.openship.io";
beforeEach(() => {
  vi.clearAllMocks();
  h.enabled.mockReturnValue(true);
  h.payment.mockResolvedValue(true);
  h.subscription.mockResolvedValue(undefined);
  h.recheck.mockResolvedValue(undefined);
});
describe("Cloud analytics gates and verified billing semantics", () => {
  it("requires explicit production SaaS configuration, regardless of Cloud connectivity or keys", () => {
    expect(resolveCloudAnalyticsConfig(environment, url)?.host).toBe(environment.POSTHOG_HOST);
    for (const override of [
      { CLOUD_MODE: false },
      { DEPLOY_MODE: "desktop" },
      { NODE_ENV: "development" },
      { NODE_ENV: "test" },
      { POSTHOG_ENABLED: false },
      { POSTHOG_PROJECT_KEY: "" },
      { POSTHOG_PROJECT_KEY: "phx_personal" },
      { POSTHOG_HOST: "https://attacker.example/collect" },
    ])
      expect(resolveCloudAnalyticsConfig({ ...environment, ...override }, url)).toBeNull();
    expect(resolveCloudAnalyticsConfig(environment, "http://localhost:3001")).toBeNull();
  });
  it("never treats grants, credits or entitlement changes as revenue", async () => {
    const event = {
      paymentId: "payment-1",
      checkoutId: "checkout-1",
      kind: "topup",
      amount: { unitAmount: 1000, currency: "usd" },
    };
    for (const kind of ["credits.usage", "entitlement.changed", "subscription.updated"])
      await observeVerifiedBillingEvent("org", kind, event);
    expect(h.payment).not.toHaveBeenCalled();
    await observeVerifiedBillingEvent("org", "payment.succeeded", event);
    expect(h.payment).toHaveBeenCalledWith(
      { organizationId: "org" },
      {
        paymentId: "payment-1",
        checkoutId: "checkout-1",
        kind: "topup",
        amount: 1000,
        renewed: false,
      },
      undefined,
    );
    expect(h.recheck).toHaveBeenCalledWith("org", "checkout-1");
  });
  it("rejects unverified amounts/currencies and mismatched provider metadata", async () => {
    for (const data of [
      { paymentId: "pi", kind: "subscription" },
      { paymentId: "pi", kind: "subscription", amount: { unitAmount: -20, currency: "usd" } },
      { paymentId: "pi", kind: "subscription", amount: { unitAmount: 1000, currency: "eur" } },
      {
        paymentId: "pi",
        kind: "subscription",
        amount: { unitAmount: 1000, currency: "usd" },
        metadata: { openship_organization: "another" },
      },
    ])
      await observeVerifiedBillingEvent("org", "payment.succeeded", data);
    expect(h.payment).not.toHaveBeenCalled();
  });
  it("uses verified annual contract prices for MRR and excludes complimentary/trial/free access", async () => {
    const subscription: OblienSubscription = {
      tierId: "reseller",
      status: "active",
      billingInterval: "yearly",
      periodStart: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      offer: { name: "Pro", unitAmount: 24000, currency: "usd", credits: 500 },
    };
    await observeCloudSubscription("org", { tier: "pro", subscription, grant: null });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ paying: true, mrr_cents: 2000, interval: "annual" }),
    );
    await observeCloudSubscription("org", { tier: "pro", subscription, grant: {} });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ paying: false, mrr_cents: 0, billing_source: "complimentary" }),
    );
    await observeCloudSubscription("org", {
      tier: "pro",
      subscription: { ...subscription, status: "trialing" },
      grant: null,
    });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ paying: false, mrr_cents: 0 }),
    );
    await observeCloudSubscription("org", { tier: "free", subscription, grant: null });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ paying: false, mrr_cents: 0 }),
    );
    await observeCloudSubscription("org", {
      tier: "pro",
      subscription: { ...subscription, offer: undefined },
      grant: null,
    });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ paying: true, mrr_cents: null }),
    );
  });
  it("keeps cancellation scheduled at period end paying until the verified subscription ends", async () => {
    const subscription: OblienSubscription = {
      tierId: "reseller",
      status: "active",
      billingInterval: "monthly",
      periodStart: null,
      periodEnd: null,
      cancelAtPeriodEnd: true,
      canceledAt: null,
      offer: { name: "Pro", unitAmount: 2000, currency: "usd", credits: 500 },
    };
    await observeCloudSubscription("org", { tier: "pro", subscription, grant: null });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ cancel_at_period_end: true, paying: true, mrr_cents: 2000 }),
    );
    await observeCloudSubscription("org", {
      tier: "pro",
      subscription: { ...subscription, status: "canceled" },
      grant: null,
    });
    expect(h.subscription).toHaveBeenLastCalledWith(
      "org",
      expect.objectContaining({ paying: false, mrr_cents: 0 }),
    );
  });
});
