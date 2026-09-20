import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { OblienBillingApi } from "@repo/platform/engine/lib/oblien-billing-api";

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const entitlement = { success: true, namespace: "os-one", tierId: "pro", status: "active", periodStart: null, periodEnd: null, quota: { limit: 3000, used: -50, balance: 3050 } };
const subscription = { success: true, namespace: "os-one", subscription: {
  tierId: "pro", status: "active", billingInterval: "monthly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
  cancelAtPeriodEnd: true, canceledAt: "2026-09-15T00:00:00Z",
} };
function setup(body: unknown, status = 200) {
  const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(body, { status }));
  const api = new OblienBillingApi({ clientId: "test-id", clientSecret: "test-secret", fetch: fetcher as unknown as typeof fetch });
  return { api, fetcher };
}
describe("Oblien 2.4 billing SDK and transport contract", () => {
  it("accepts the live catalog's custom Enterprise allowances without breaking paid checkout", async () => {
    const catalog = { success: true, plans: [
      { tierId: "hobby", name: "Hobby", priceMonthly: 10, priceYearly: 100, currency: "USD", creditsPerCycle: 1200, yearlyCreditsPerCycle: 14400, overdraftCredits: 100, features: [] },
      { tierId: "enterprise", name: "Enterprise", priceMonthly: null, priceYearly: null, currency: "USD", creditsPerCycle: null, yearlyCreditsPerCycle: null, overdraftCredits: null, features: [] },
    ], creditPacks: [] };
    const { api } = setup(catalog);
    expect(await api.getCatalog()).toEqual(catalog);
    catalog.plans[0]!.overdraftCredits = -1;
    await expect(api.getCatalog()).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it("authenticates server requests and validates the returned customer namespace", async () => {
    const { api, fetcher } = setup(entitlement);
    expect((await api.getEntitlement("os-one")).quota.used).toBe(-50);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/entitlement?namespace=os-one", expect.objectContaining({
      headers: expect.objectContaining({ "X-Client-ID": "test-id", "X-Client-Secret": "test-secret" }), redirect: "error",
    }));
    await expect(api.getEntitlement("os-two")).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("reads the public catalog without transmitting reseller credentials", async () => {
    const { api, fetcher } = setup({ success: true, plans: [], creditPacks: [] });
    await api.getCatalog();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Accept: "application/json" } });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("X-Client-Secret");
  });
  it("posts the documented namespace, interval and idempotency key", async () => {
    const { api, fetcher } = setup({ success: true, url: "https://checkout.stripe.com/c/pay/test", checkoutId: "cs_test" });
    const input = { namespace: "os-one", kind: "subscription" as const, planTierId: "hobby", billingInterval: "yearly" as const,
      successUrl: "https://app.openship.io/billing/overview", cancelUrl: "https://app.openship.io/billing/plans", idempotencyKey: "checkout-123" };
    await api.createCheckout(input);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/checkout", expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
  });
  it("rejects unexpected checkout hosts and malformed entitlements", async () => {
    await expect(setup({ success: true, url: "https://example.com/payment", checkoutId: "cs_1" }).api.createCheckout({
      namespace: "os-one", kind: "topup", packId: "starter", successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "topup-1",
    })).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    await expect(setup({ ...entitlement, status: "unrecognized" }).api.getEntitlement("os-one")).rejects.toMatchObject({ statusCode: 502 });
  });
  it("does not expose provider error bodies or silently retry a purchase", async () => {
    const { api, fetcher } = setup({ success: false, message: "private account detail" }, 500);
    await expect(api.getEntitlement("os-one")).rejects.toThrow("Cloud billing could not complete");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reports the live checkout collation failure as unavailable and keeps safe diagnostics in server logs", async () => {
    const { api, fetcher } = setup({ success: false, error: "ER_CANT_AGGREGATE_NCOLLATIONS", code: "ER_CANT_AGGREGATE_NCOLLATIONS",
      message: "Failed to create subscription checkout", details: { sql: "private query", customer: "cus_private" } }, 400);
    const error = await api.createCheckout({ namespace: "private-customer", kind: "subscription", planTierId: "hobby", billingInterval: "monthly",
      successUrl: "https://app.openship.io/billing/overview", cancelUrl: "https://app.openship.io/billing/plans", idempotencyKey: "private-attempt" }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: "OBLIEN_CHECKOUT_UNAVAILABLE", message: "Cloud checkout is temporarily unavailable. Please try again later." });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[oblien:billing] Provider request failed", {
      method: "POST", operation: "/billing/checkout", providerStatus: 400, providerCode: "ER_CANT_AGGREGATE_NCOLLATIONS",
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private|test-secret/);
    expect(JSON.stringify(error)).not.toContain("ER_CANT_AGGREGATE_NCOLLATIONS");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("retains actionable plan validation failures instead of treating them as checkout outages", async () => {
    const { api } = setup({ success: false, code: "invalid_plan", message: "private provider detail" }, 400);
    await expect(api.createCheckout({ namespace: "os-one", kind: "subscription", planTierId: "hobby", billingInterval: "monthly",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt" })).rejects.toMatchObject({
      statusCode: 400, code: "OBLIEN_BILLING_ERROR", message: "This plan is no longer available. Refresh the plans page.",
    });
  });
  it.each([400, 503])("preserves the documented billing diagnostic reference for an HTTP %s storage failure", async status => {
    const { api, fetcher } = setup({ success: false, code: "billing_database_collation_error", message: "private provider detail",
      details: { reference: "billing-support-123", retryable: false, cause: "ER_CANT_AGGREGATE_NCOLLATIONS", sql: "private query", clientSecret: "test-secret" } }, status);
    const error = await api.createCheckout({ namespace: "private-customer", kind: "subscription", planTierId: "hobby", billingInterval: "monthly",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt" }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: "OBLIEN_CHECKOUT_UNAVAILABLE",
      message: "Cloud billing is unavailable. Contact Openship support. Reference: billing-support-123.",
      details: { providerCode: "billing_database_collation_error", details: { reference: "billing-support-123", retryable: false } },
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[oblien:billing] Provider request failed", {
      method: "POST", operation: "/billing/checkout", providerStatus: status, providerCode: "billing_database_collation_error",
      reference: "billing-support-123", retryable: false,
    });
    expect(JSON.stringify([error, vi.mocked(console.warn).mock.calls])).not.toMatch(/private|test-secret|ER_CANT/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    [400, "billing_redirect_not_allowed", "return links are not configured"],
    [409, "billing_idempotency_conflict", "no longer matches the original request"],
    [409, "billing_checkout_reconciliation_required", "earlier checkout needs to be reviewed"],
  ] as const)("explains %s/%s without starting another payment", async (status, code, message) => {
    const { api, fetcher } = setup({ success: false, code, message: "private provider detail" }, status);
    const error = await api.createCheckout({ namespace: "os-one", kind: "topup", packId: "starter",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt" }).catch(error => error);
    expect(error).toMatchObject({ statusCode: status, details: { providerCode: code } });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("private");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["sk_private", "test-secret", "user@private.test", "bad\nreference", "x".repeat(129)])("does not expose unsafe diagnostic reference %s", async reference => {
    const error = await setup({ success: false, code: "billing_storage_unavailable", details: { reference } }, 503)
      .api.getPolicy("private-customer").catch(error => error);
    expect(error.message).not.toContain(reference);
    expect(error.details).not.toHaveProperty("details.reference");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(reference);
  });
  it.each(["private account detail\nsecret", "cus_private", "sk_private", "x".repeat(81)])("does not log arbitrary provider error code %s", async code => {
    await setup({ success: false, code, message: "private account detail" }, 500).api.getPolicy("private-customer").catch(() => {});
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[oblien:billing] Provider request failed", {
      method: "GET", operation: "/billing/policy/:namespace", providerStatus: 500, providerCode: "unknown",
    });
  });
  it("retains upstream authentication status in diagnostics without a namespace or credential", async () => {
    await expect(setup({ success: false, code: "unauthorized" }, 401).api.getSubscription("private-customer"))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[oblien:billing] Provider request failed", {
      method: "GET", operation: "/billing/subscription", providerStatus: 401, providerCode: "unauthorized",
    });
  });
  it("opens only the supplied namespace's portal with a safe hosted URL", async () => {
    const { api, fetcher } = setup({ success: true, namespace: "os-one", url: "https://billing.stripe.com/p/session/test" });
    const input = { namespace: "os-one", returnUrl: "https://app.openship.io/billing/overview" };
    expect((await api.createPortal(input)).url).toBe("https://billing.stripe.com/p/session/test");
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/portal", expect.objectContaining({ method: "POST", body: JSON.stringify(input), redirect: "error", signal: expect.any(AbortSignal) }));
    await expect(api.createPortal({ ...input, namespace: "os-two" })).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("rejects a legacy owner portal even when its hosted URL is otherwise valid", async () => {
    const { api } = setup({ success: true, url: "https://billing.stripe.com/p/session/owner" });
    await expect(api.createPortal({ namespace: "os-one", returnUrl: "https://app.openship.io" }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it.each(["http://billing.stripe.com/session", "https://billing.stripe.com.evil.test/session", "https://billing.stripe.com:8443/session", "https://user:password@billing.stripe.com/session"])("rejects unsafe portal URL %s", async (url) => {
    await expect(setup({ success: true, namespace: "os-one", url }).api.createPortal({ namespace: "os-one", returnUrl: "https://app.openship.io" }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it.each([
    ["getSubscription", "GET", "/billing/subscription?namespace=os-one"],
    ["cancelSubscription", "POST", "/billing/subscription/cancel"],
    ["resumeSubscription", "POST", "/billing/subscription/resume"],
  ] as const)("uses the SDK %s method and checks the response namespace", async (method, verb, path) => {
    const { api, fetcher } = setup(subscription);
    expect(await api[method]("os-one")).toEqual(subscription);
    expect(fetcher).toHaveBeenCalledWith(`https://api.oblien.com${path}`, expect.objectContaining({
      method: verb, ...(verb === "POST" ? { body: JSON.stringify({ namespace: "os-one" }) } : {}),
    }));
    await expect(api[method]("os-two")).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("distinguishes never subscribed from a malformed subscription", async () => {
    expect((await setup({ ...subscription, subscription: null }).api.getSubscription("os-one")).subscription).toBeNull();
    await expect(setup({ ...subscription, subscription: { ...subscription.subscription, cancelAtPeriodEnd: "false" } }).api.getSubscription("os-one"))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it.each([
    [404, "no_customer", "Complete a checkout first"],
    [409, "billing_customer_conflict", "Contact support"],
    [409, "billing_identity_conflict", "Contact support"],
    [409, "subscription_ended", "Start a new checkout"],
  ])("preserves actionable %s/%s errors without exposing provider identities", async (status, code, message) => {
    const { api } = setup({ success: false, code, message: "private customer cus_secret subscription sub_secret" }, status as number);
    const error = await api.createPortal({ namespace: "os-one", returnUrl: "https://app.openship.io" }).catch(error => error);
    expect(error.statusCode).toBe(status);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("secret");
  });
  it("requires server credentials for management but not the public catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, plans: [], creditPacks: [] }));
    const api = new OblienBillingApi({ fetch: fetcher as unknown as typeof fetch });
    await api.getCatalog();
    await expect(api.getSubscription("os-one")).rejects.toMatchObject({ code: "BILLING_NOT_CONFIGURED" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not accept an HTTP failure just because the response body claims success", async () => {
    await expect(setup(subscription, 503).api.getSubscription("os-one")).rejects.toMatchObject({ statusCode: 503 });
  });
});
