import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { OblienBillingApi, oblienOfferSchema, assertOblienEntitlementMatchesSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
import { BillingOperationSchemas } from "@repo/contracts";
import { Value } from "@sinclair/typebox/value";
import capacityCatalog from "../../../test/fixtures/oblien-capacity-catalog.json";
import { monthlyCloudBilling } from "../../../test/helpers/monthly-cloud-offer";

beforeEach(() => vi.spyOn(errorDiagnostics, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const offer = { name: "Example SaaS", unitAmount: 1000, credits: 100, currency: "usd" as const };
const metadata = { app_order: "test-order" };
it("checkout-status input supports both provider ID formats without path or scope injection", () => {
  const schema = BillingOperationSchemas.getCheckout.input;
  for (const checkoutId of ["cs_test_requested", "bco_24f15202-6a3d-4b27-b7c2-c3abbc401bee"])
    expect(Value.Check(schema, { checkoutId })).toBe(true);
  for (const checkoutId of ["../private", "cs_a?namespace=other", "bco_invalid", "cs_a/other", "", "cs_a#fragment"])
    expect(Value.Check(schema, { checkoutId })).toBe(false);
  expect(Value.Check(schema, { checkoutId: "cs_valid", namespace: "other-organization" })).toBe(false);
});
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
describe("Oblien billing SDK and transport contract", () => {
  it("quotes the live VM credit meter and ignores preview rate cards without sending credentials", async () => {
    const live = { success: true, credits_per_dollar: 100, rate_card_id: "live", rates: { cpu_per_min: 1.5, memory_per_gb_min: 0.2, disk_per_gb: 0, network_per_gb: 0.15 } };
    const { api, fetcher } = setup({ ...live, compute_rate_cards: [{ chargeEnabled: false, cpu_per_min: 0.001 }] });
    expect(await api.getMeteredPricing()).toEqual(live);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/pricing/calculator", expect.objectContaining({ method: "GET", redirect: "error", headers: { Accept: "application/json" } }));
  });
  it.each([
    { credits_per_dollar: 50, rate_card_id: "new", rates: { cpu_per_min: 1, memory_per_gb_min: 1, disk_per_gb: 0, network_per_gb: 0 } },
    { credits_per_dollar: 100, rate_card_id: "new", rates: { cpu_per_min: -1, memory_per_gb_min: 1, disk_per_gb: 0, network_per_gb: 0 } },
    { credits_per_dollar: 100, rate_card_id: "new", compute_rate_cards: [] },
  ])("refuses malformed meter prices or a changed credit conversion", async body => {
    await expect(setup({ success: true, ...body }).api.getMeteredPricing()).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it("reads a pending capacity checkout without exposing the reseller wallet or prices", async () => {
    const pendingCheckout = { quote: { id: "quote_pending", namespace: "os-one", paymentSource: "stripe", wholesaleAmount: 940 },
      checkoutId: "cs_requested", url: "https://checkout.stripe.com/c/pay/test" };
    const { api, fetcher } = setup({ success: true, namespace: "os-one", pendingCheckout, wallet: { balance: 12000 } });
    expect(await api.getPendingCapacityCheckout("os-one")).toEqual({ success: true, namespace: "os-one",
      pendingCheckout: { ...pendingCheckout, quote: { id: "quote_pending", namespace: "os-one", paymentSource: "stripe" } } });
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.oblien.com/billing/capacity?namespace=os-one");
    await expect(api.getPendingCapacityCheckout("os-other")).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("cancels a capacity payment with the saved provider quote and retry identity", async () => {
    const { api, fetcher } = setup({ success: true, namespace: "os-one", pendingCheckout: null });
    const input = { quoteId: "quote_pending", idempotencyKey: "cancel-once" };
    await expect(api.cancelCapacityCheckout("os-one", input)).resolves.toMatchObject({ pendingCheckout: null });
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/capacity/change/cancel", expect.objectContaining({
      method: "POST",
    }));
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ namespace: "os-one", ...input });
  });
  it.each([
    { quote: { id: "quote_pending", namespace: "os-other", paymentSource: "stripe" }, checkoutId: "cs_requested", url: null },
    { quote: { id: "quote_pending", namespace: "os-one", paymentSource: "stripe" }, checkoutId: "cs_requested", url: "https://evil.example/pay" },
    { quote: { id: "quote_pending", namespace: "os-one", paymentSource: "stripe" }, checkoutId: "cs_requested", url: "https://api.oblien.com/not-a-payment#secret" },
  ])("rejects foreign capacity scope and untrusted resume URLs", async pendingCheckout => {
    await expect(setup({ success: true, namespace: "os-one", pendingCheckout }).api.getPendingCapacityCheckout("os-one")).rejects.toThrow();
  });
  it("rejects malformed capacity payment URLs without exposing the provider response", async () => {
    const pendingCheckout = { quote: { id: "quote_pending", namespace: "os-one", paymentSource: "stripe" },
      checkoutId: "cs_requested", url: "malformed-payment-capability" };
    await expect(setup({ success: true, namespace: "os-one", pendingCheckout }).api.getPendingCapacityCheckout("os-one"))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE", message: "Cloud billing returned an invalid response" });
  });
  it("scopes complimentary policy writes to the requested namespace and validates the response", async () => {
    const policy = { quotaLimit: 3000, overdraft: 60, suspendThreshold: 60, onOverdraftAction: "stop_workspaces" as const };
    const result = { success: true, namespace: "os-one", service: "workspace_vm", ...policy };
    const { api, fetcher } = setup(result);
    expect(await api.setPolicy("os-one", policy)).toEqual(result);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/policy/os-one", expect.objectContaining({ method: "PUT", body: JSON.stringify(policy) }));
    await expect(api.setPolicy("os-two", policy)).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("keeps the same provider reset key on retry and rejects an unscoped reset response", async () => {
    const { api, fetcher } = setup({ success: true, namespace: "os-one", applied: false });
    expect(await api.resetQuota("os-one", "2026-10-25T14:00:00.000Z")).toMatchObject({ applied: false });
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/policy/os-one/reset", expect.objectContaining({ method: "POST", body: JSON.stringify({ periodEnd: "2026-10-25T14:00:00.000Z" }) }));
    await expect(setup({ success: true, applied: true }).api.resetQuota("os-one", "2026-10-25T14:00:00.000Z"))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it("requires the generic saved-policy contract before enabling new Cloud offers", async () => {
    const catalog = { success: true, plans: [], creditPacks: [] };
    await expect(setup(catalog).api.assertResellerSupport()).rejects.toMatchObject({
      code: "OBLIEN_BILLING_UPGRADE_REQUIRED",
    });
    await expect(
      setup({
        ...catalog,
        reseller: { contractVersion: 2, offerPolicy: true, resourceLimits: true, effectiveResourceLimits: true, aggregateResourceLimits: true },
      }).api.assertResellerSupport(),
    ).resolves.toBeUndefined();
    await expect(
      setup({
        ...catalog,
        reseller: { contractVersion: 2, offerPolicy: true, resourceLimits: false },
      }).api.assertResellerSupport(),
    ).rejects.toMatchObject({ code: "OBLIEN_BILLING_UPGRADE_REQUIRED" });
  });
  it.each([undefined, false])("requires Oblien capacity resolution before a new sale", async effectiveResourceLimits => {
    await expect(setup({ success: true, plans: [], creditPacks: [],
      reseller: { contractVersion: 2, offerPolicy: true, resourceLimits: true, effectiveResourceLimits },
    }).api.assertResellerSupport()).rejects.toMatchObject({ code: "OBLIEN_BILLING_UPGRADE_REQUIRED" });
  });
  it.each([undefined, false])("requires aggregate enforcement before selling bounded offers (%s)", async aggregateResourceLimits => {
    await expect(setup({ success: true, plans: [], creditPacks: [], reseller: { contractVersion: 2, offerPolicy: true,
      resourceLimits: true, effectiveResourceLimits: true, aggregateResourceLimits } }).api.assertResellerSupport())
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_UPGRADE_REQUIRED" });
  });
  it("retains the immutable offer, policy, limits and reseller metadata on subscription reads", async () => {
    const saved = {
      ...subscription,
      subscription: {
        ...subscription.subscription,
        tierId: "reseller",
        offer: {
          ...offer,
          reference: "example:plan:v1",
          policy: { overdraft: 60, suspendThreshold: 60, onOverdraftAction: "stop_workspaces" },
          resourceLimits: { max_workspaces: 3, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 32 },
        },
        metadata: { application_order: "example-order" },
      },
    };
    expect(await setup(saved).api.getSubscription("os-one")).toEqual(saved);
  });
  it("binds checkout verification to both the requested namespace and exact session, without exposing payment internals", async () => {
    const result = {
      success: true,
      namespace: "os-one",
      checkout: {
        id: "cs_requested",
        kind: "topup",
        status: "complete",
        paymentStatus: "paid",
        fulfilled: true,
        fulfillmentStatus: "completed",
        namespaceCreditsGranted: 500,
        walletCredits: 1000,
        paymentId: "pi_private",
      },
    };
    const { api, fetcher } = setup(result);
    const state = await api.getCheckout("os-one", "cs_requested");
    expect(state.checkout).toMatchObject({ id: "cs_requested", namespaceCreditsGranted: 500 });
    expect(state.checkout).not.toHaveProperty("walletCredits");
    expect(state.checkout).not.toHaveProperty("paymentId");
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.oblien.com/billing/checkout/cs_requested?namespace=os-one",
    );
    await expect(api.getCheckout("os-other", "cs_requested")).rejects.toMatchObject({
      code: "OBLIEN_BILLING_NAMESPACE_MISMATCH",
    });
    await expect(api.getCheckout("os-one", "cs_other")).rejects.toMatchObject({
      code: "OBLIEN_BILLING_INVALID_RESPONSE",
    });
  });
  it("does not log the checkout session credential when status lookup fails", async () => {
    const { api } = setup({ success: false, code: "no_checkout" }, 404);
    await expect(api.getCheckout("os-one", "cs_private_payment_session")).rejects.toThrow(
      "No checkout was found for this organization",
    );
    expect(errorDiagnostics.warn).toHaveBeenCalledWith(
      expect.any(String),
      "[oblien:billing] Provider request failed",
      expect.objectContaining({ operation: "/billing/checkout/:checkoutId" }),
    );
    expect(JSON.stringify(vi.mocked(errorDiagnostics.warn).mock.calls)).not.toContain(
      "cs_private_payment_session",
    );
  });
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
    const input = {
      namespace: "os-one",
      kind: "subscription" as const,
      offer,
      metadata,
      billingInterval: "yearly" as const,
      successUrl: "https://app.openship.io/billing/overview",
      cancelUrl: "https://app.openship.io/billing/plans",
      idempotencyKey: "checkout-123",
    };
    await api.createCheckout(input);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/checkout", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ ...input, allowPromotionCodes: true });
  });
  it("accepts the exact Oblien promotion checkout and preserves its opaque ID", async () => {
    const checkoutId = "bco_24f15202-6a3d-4b27-b7c2-c3abbc401bee";
    const url = `https://api.oblien.com/billing/pay#${"a".repeat(43)}`;
    const { api } = setup({ success: true, url, checkoutId });
    await expect(api.createCheckout({ namespace: "os-one", kind: "topup", offer, metadata,
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "promotion-checkout" }))
      .resolves.toMatchObject({ url, checkoutId });
  });
  it.each([
    "http://api.oblien.com/billing/pay", "https://api.oblien.com.evil.example/billing/pay",
    "https://api.oblien.com/billing/pay?return=https://evil.example", "https://api.oblien.com/other",
    "https://api.oblien.com/billing/pay", "https://user@api.oblien.com/billing/pay",
    "https://api.oblien.com:8443/billing/pay", "https://api.oblien.com/billing/pay/",
  ])("rejects an invalid promotion checkout URL: %s", async (value) => {
    const url = value + (value === "https://api.oblien.com/billing/pay" ? "#short" : `#${"a".repeat(43)}`);
    await expect(setup({ success: true, url, checkoutId: "bco_24f15202-6a3d-4b27-b7c2-c3abbc401bee" }).api.createCheckout({
      namespace: "os-one", kind: "topup", offer, metadata, successUrl: "https://app.openship.io",
      cancelUrl: "https://app.openship.io", idempotencyKey: "bad-promotion-checkout" }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it("rejects unexpected checkout hosts and malformed entitlements", async () => {
    await expect(
      setup({
        success: true,
        url: "https://example.com/payment",
        checkoutId: "cs_1",
      }).api.createCheckout({
        namespace: "os-one",
        kind: "topup",
        offer,
        metadata,
        successUrl: "https://app.openship.io",
        cancelUrl: "https://app.openship.io",
        idempotencyKey: "topup-1",
      }),
    ).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    await expect(setup({ ...entitlement, status: "unrecognized" }).api.getEntitlement("os-one")).rejects.toMatchObject({ statusCode: 502 });
  });
  it("does not expose provider error bodies or silently retry a purchase", async () => {
    const { api, fetcher } = setup({ success: false, message: "private account detail" }, 500);
    await expect(api.getEntitlement("os-one")).rejects.toThrow("Cloud billing could not complete");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["capacity_unavailable", "billing_capacity_unavailable"])("identifies unavailable capacity (%s) without abandoning an uncertain checkout", async code => {
    const { api, fetcher } = setup({ success: false, code,
      message: "private provider capacity details", details: { customer: "cus_private" } }, 503);
    const error = await api.createCheckout({ namespace: "os-one", kind: "subscription", offer, metadata,
      billingInterval: "monthly", successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io",
      idempotencyKey: "private-attempt" }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: "CLOUD_CAPACITY_UNAVAILABLE",
      message: "This server size is temporarily unavailable. Please try again later or contact support.",
      details: { providerCode: code } });
    expect(error.details).not.toHaveProperty("checkoutRejected");
    expect(error.details).not.toHaveProperty("checkoutExpired");
    expect(JSON.stringify(error)).not.toMatch(/private|test-secret/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("treats reseller eligibility as an operator setup issue without asking the customer to upgrade", async () => {
    const { api, fetcher } = setup({ success: false, code: "reseller_enterprise_required",
      message: "private owner identity", details: { accountTier: "free", requiredAccountTier: "enterprise" } }, 403);
    const error = await api.createCheckout({
      namespace: "os-one", kind: "subscription", offer, metadata, billingInterval: "monthly",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt",
    }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: "OBLIEN_CHECKOUT_UNAVAILABLE",
      message: "Cloud payments require an account configuration update by Openship. Contact Openship support.",
      details: { providerCode: "reseller_enterprise_required", checkoutRejected: true },
    });
    expect(JSON.stringify(error)).not.toMatch(/private|accountTier/);
    expect(error.message).not.toMatch(/enterprise|upgrade/i);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reports the live checkout collation failure as unavailable and keeps safe diagnostics in server logs", async () => {
    const { api, fetcher } = setup({ success: false, error: "ER_CANT_AGGREGATE_NCOLLATIONS", code: "ER_CANT_AGGREGATE_NCOLLATIONS",
      message: "Failed to create subscription checkout", details: { sql: "private query", customer: "cus_private" } }, 400);
    const error = await api
      .createCheckout({
        namespace: "private-customer",
        kind: "subscription",
        offer,
        metadata,
        billingInterval: "monthly",
        successUrl: "https://app.openship.io/billing/overview",
        cancelUrl: "https://app.openship.io/billing/plans",
        idempotencyKey: "private-attempt",
      })
      .catch((error) => error);
    expect(error).toMatchObject({ statusCode: 503, code: "OBLIEN_CHECKOUT_UNAVAILABLE", message: "Cloud checkout is temporarily unavailable. Please try again later." });
    expect(errorDiagnostics.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "[oblien:billing] Provider request failed", {
      method: "POST", operation: "/billing/checkout", providerStatus: 400, providerCode: "ER_CANT_AGGREGATE_NCOLLATIONS",
    });
    expect(JSON.stringify(vi.mocked(errorDiagnostics.warn).mock.calls)).not.toMatch(/private|test-secret/);
    expect(JSON.stringify(error)).not.toContain("ER_CANT_AGGREGATE_NCOLLATIONS");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("retains actionable plan validation failures instead of treating them as checkout outages", async () => {
    const { api } = setup({ success: false, code: "invalid_plan", message: "private provider detail" }, 400);
    await expect(
      api.createCheckout({
        namespace: "os-one",
        kind: "subscription",
        offer,
        metadata,
        billingInterval: "monthly",
        successUrl: "https://app.openship.io",
        cancelUrl: "https://app.openship.io",
        idempotencyKey: "attempt",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "OBLIEN_BILLING_ERROR",
      message: "This plan is no longer available. Refresh the plans page.",
    });
  });
  it.each([400, 503])("preserves the documented billing diagnostic reference for an HTTP %s storage failure", async status => {
    const { api, fetcher } = setup({ success: false, code: "billing_database_collation_error", message: "private provider detail",
      details: { reference: "billing-support-123", retryable: false, cause: "ER_CANT_AGGREGATE_NCOLLATIONS", sql: "private query", clientSecret: "test-secret" } }, status);
    const error = await api
      .createCheckout({
        namespace: "private-customer",
        kind: "subscription",
        offer,
        metadata,
        billingInterval: "monthly",
        successUrl: "https://app.openship.io",
        cancelUrl: "https://app.openship.io",
        idempotencyKey: "attempt",
      })
      .catch((error) => error);
    expect(error).toMatchObject({ statusCode: 503, code: "OBLIEN_CHECKOUT_UNAVAILABLE",
      message: "Cloud billing is unavailable. Contact Openship support. Reference: billing-support-123.",
      details: { providerCode: "billing_database_collation_error", details: { reference: "billing-support-123", retryable: false } },
    });
    expect(errorDiagnostics.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "[oblien:billing] Provider request failed", {
      method: "POST", operation: "/billing/checkout", providerStatus: status, providerCode: "billing_database_collation_error",
      reference: "billing-support-123", retryable: false,
    });
    expect(JSON.stringify([error, vi.mocked(errorDiagnostics.warn).mock.calls])).not.toMatch(/private|test-secret|ER_CANT/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    [400, "billing_redirect_not_allowed", "return links are not configured"],
    [400, "invalid_redirect_url", "valid HTTPS return link"],
    [400, "capacity_price_below_cost", "Cloud pricing is not configured correctly"],
    [409, "billing_idempotency_conflict", "no longer matches the original request"],
    [409, "billing_checkout_reconciliation_required", "earlier checkout needs to be reviewed"],
  ] as const)("explains %s/%s without starting another payment", async (status, code, message) => {
    const { api, fetcher } = setup({ success: false, code, message: "private provider detail" }, status);
    const error = await api
      .createCheckout({
        namespace: "os-one",
        kind: "topup",
        offer,
        metadata,
        successUrl: "https://app.openship.io",
        cancelUrl: "https://app.openship.io",
        idempotencyKey: "attempt",
      })
      .catch((error) => error);
    expect(error).toMatchObject({ statusCode: status, details: { providerCode: code } });
    expect(error.details.checkoutRejected).toBe(status === 400 ? true : undefined);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("private");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not classify a provider outage as a confirmed checkout rejection", async () => {
    const { api } = setup({ success: false, code: "invalid_offer" }, 500);
    const error = await api.createCheckout({
      namespace: "os-one", kind: "subscription", offer, metadata, billingInterval: "monthly",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt",
    }).catch(error => error);
    expect(error.details.checkoutRejected).toBeUndefined();
  });
  it.each([410, 404, 500].flatMap(status => ["checkout_expired", "capacity_checkout_expired"].map(code => [status, code] as const)))("trusts only the explicit checkout expiry (%s/%s)", async (status, code) => {
    const { api } = setup({ success: false, code, message: "private provider detail" }, status);
    const error = await api.createCheckout({
      namespace: "os-one", kind: "subscription", offer, metadata, billingInterval: "monthly",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt",
    }).catch(error => error);
    expect(error).toMatchObject({ statusCode: status === 500 ? 503 : status,
      message: "This checkout has expired. Choose your plan again to start a new checkout.",
      details: { providerCode: code },
    });
    expect(error.details.checkoutExpired).toBe(status === 410 ? true : undefined);
    expect(error.details.checkoutRejected).toBeUndefined();
  });
  it.each([402, 500])("handles HTTP %s reseller funding failures without exposing the owner's wallet", async status => {
    const { api } = setup({ success: false, code: "insufficient_redeemable_balance",
      message: "Private wallet funding detail", requiredCredits: 625, eligibleCredits: 0, walletCredits: 11780,
    }, status);
    const error = await api.createCheckout({
      namespace: "os-one", kind: "subscription", offer, metadata, billingInterval: "monthly",
      successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "attempt",
    }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: "OBLIEN_CHECKOUT_UNAVAILABLE",
      message: "Cloud server purchases are temporarily unavailable. Contact Openship support.",
      details: { providerCode: "insufficient_redeemable_balance" },
    });
    expect(error.details.checkoutRejected).toBe(status === 402 ? true : undefined);
    expect(JSON.stringify([error, vi.mocked(errorDiagnostics.warn).mock.calls])).not.toMatch(/Private|625|11780|walletCredits|eligibleCredits/);
  });
  it.each(["sk_private", "test-secret", "user@private.test", "bad\nreference", "x".repeat(129)])("does not expose unsafe diagnostic reference %s", async reference => {
    const error = await setup({ success: false, code: "billing_storage_unavailable", details: { reference } }, 503)
      .api.getPolicy("private-customer").catch(error => error);
    expect(error.message).not.toContain(reference);
    expect(error.details).not.toHaveProperty("details.reference");
    expect(JSON.stringify(vi.mocked(errorDiagnostics.warn).mock.calls)).not.toContain(reference);
  });
  it.each(["private account detail\nsecret", "cus_private", "sk_private", "x".repeat(81)])("does not log arbitrary provider error code %s", async code => {
    await setup({ success: false, code, message: "private account detail" }, 500).api.getPolicy("private-customer").catch(() => {});
    expect(errorDiagnostics.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "[oblien:billing] Provider request failed", {
      method: "GET", operation: "/billing/policy/:namespace", providerStatus: 500, providerCode: "unknown",
    });
  });
  it("retains upstream authentication status in diagnostics without a namespace or credential", async () => {
    await expect(setup({ success: false, code: "unauthorized" }, 401).api.getSubscription("private-customer"))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(errorDiagnostics.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "[oblien:billing] Provider request failed", {
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

describe("Oblien monthly capacity contract", () => {
  it("reads the deployed capacity catalog through the SDK without credentials or local price calculations", async () => {
    const { api, fetcher } = setup(capacityCatalog);
    const catalog = await api.assertMonthlyCapacitySupport();
    expect(catalog.tariff.usage).toEqual({ activeVcpuHourCents: 3, reservedGiBHourCents: 0.8, retainedGiBMonthCents: 5, monthHours: 720 });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.oblien.com/billing/capacity/catalog");
    expect(request?.headers).not.toHaveProperty("X-Client-Secret");
    expect(request?.headers).not.toHaveProperty("X-Client-ID");
  });
  it("pauses new sales when Stripe monthly purchases are unavailable", async () => {
    const catalog = structuredClone(capacityCatalog);
    catalog.paymentSources.monthly = ["wallet"];
    await expect(setup(catalog).api.assertMonthlyCapacitySupport())
      .rejects.toMatchObject({ code: "OBLIEN_CAPACITY_UNAVAILABLE" });
  });
  it("accepts null quota alerts and keeps dollars distinct from cents", async () => {
    const { entitlement, subscription, balance } = monthlyCloudBilling("org-one", "os-one");
    entitlement.capacity!.retention.amountDue = 1.25;
    const received = await setup(entitlement).api.getEntitlement("os-one");
    expect(received.quota).toMatchObject({ limit: null, used: 0, balance: null, alert: null });
    expect(received.capacity).toMatchObject({ monthlyAmount: 4640, retention: { amountDue: 1.25 } });
    expect(() => assertOblienEntitlementMatchesSubscription(received, subscription)).not.toThrow();
    expect(await setup(balance).api.getBalance("os-one")).toMatchObject({ blocking: false, computeCovered: true });
  });
  it("treats equivalent ISO timestamps as the same paid period", async () => {
    const { entitlement, subscription } = monthlyCloudBilling("org-one", "os-one");
    entitlement.capacity!.periodStart = "2026-10-01T03:00:00.000+03:00";
    const received = await setup(entitlement).api.getEntitlement("os-one");
    expect(() => assertOblienEntitlementMatchesSubscription(received, subscription)).not.toThrow();
  });
  it.each(["namespace", "billingMode", "computeCovered", "periodEnd", "tierId"])("rejects a mismatched embedded capacity %s", async field => {
    const { entitlement } = monthlyCloudBilling("org-one", "os-one");
    const wrong = { namespace: "other-customer", billingMode: "payg", computeCovered: false, periodEnd: "2027-01-01T00:00:00Z", tierId: "reseller" };
    const response = field === "tierId" ? { ...entitlement, tierId: wrong.tierId }
      : { ...entitlement, capacity: { ...entitlement.capacity, [field]: wrong[field as keyof typeof wrong] } };
    await expect(setup(response).api.getEntitlement("os-one"))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it("verifies the saved subscription pool, payment source and dates before mirroring access", () => {
    for (const mutate of [
      (value: ReturnType<typeof monthlyCloudBilling>) => { value.entitlement.capacity!.capacity = { ...value.entitlement.capacity!.capacity, vcpus: 8 }; },
      (value: ReturnType<typeof monthlyCloudBilling>) => { value.entitlement.capacity!.provider = "wallet"; },
      (value: ReturnType<typeof monthlyCloudBilling>) => { value.subscription.periodEnd = "2027-01-01T00:00:00Z"; },
    ]) {
      const value = monthlyCloudBilling(); mutate(value);
      expect(() => assertOblienEntitlementMatchesSubscription(value.entitlement, value.subscription))
        .toThrow(/does not match/);
    }
  });
  it.each([0, 3900])("sends a %s-cent monthly offer through the existing hosted checkout without a credit policy", async unitAmount => {
    const { subscription } = monthlyCloudBilling("org-one", "os-one");
    subscription.offer!.unitAmount = unitAmount;
    const { api, fetcher } = setup({ success: true, url: "https://checkout.stripe.com/c/pay/test", checkoutId: "cs_monthly" });
    await api.createCheckout({ kind: "subscription", namespace: "os-one", billingInterval: "monthly",
      offer: subscription.offer!, metadata: subscription.metadata!, idempotencyKey: "saved-monthly-order",
      successUrl: "https://app.openship.io/billing/overview", cancelUrl: "https://app.openship.io/billing/plans" });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.oblien.com/billing/checkout");
    const sent = JSON.parse(String(request?.body));
    expect(sent.offer).toMatchObject({ unitAmount, credits: 0, billingMode: "monthly", capacity: { vcpus: 4, memoryMb: 16384, diskGb: 128, workspaces: 1 } });
    expect(sent.offer).not.toHaveProperty("policy");
    expect(sent.idempotencyKey).toBe("saved-monthly-order");
    expect(sent.allowPromotionCodes).toBe(unitAmount > 0);
  });
  it("retains a sponsored monthly subscription and verifies its funded capacity", async () => {
    const { entitlement, subscription } = monthlyCloudBilling("org-one", "os-one");
    subscription.offer!.unitAmount = 0;
    const received = await setup({ success: true, namespace: "os-one", subscription }).api.getSubscription("os-one");
    expect(received.subscription?.offer?.unitAmount).toBe(0);
    expect(() => assertOblienEntitlementMatchesSubscription(entitlement, received.subscription)).not.toThrow();
    entitlement.capacity!.capacity = { ...entitlement.capacity!.capacity, vcpus: 2 };
    expect(() => assertOblienEntitlementMatchesSubscription(entitlement, received.subscription)).toThrow(/does not match/);
  });
  it("rejects free metered offers and unsupported monthly prices", () => {
    expect(oblienOfferSchema.safeParse({ ...offer, unitAmount: 0 }).success).toBe(false);
    const { subscription } = monthlyCloudBilling();
    for (const unitAmount of [-1, 1, 99, 100.5, 1_000_001]) {
      expect(oblienOfferSchema.safeParse({ ...subscription.offer, unitAmount }).success).toBe(false);
    }
  });
  it("rejects hybrid monthly credit offers and missing pools", () => {
    const { subscription } = monthlyCloudBilling();
    for (const patch of [{ credits: 3500 }, { capacity: undefined }, { policy: { overdraft: 0, suspendThreshold: 0, onOverdraftAction: "block" } }]) {
      expect(oblienOfferSchema.safeParse({ ...subscription.offer, ...patch }).success).toBe(false);
    }
  });
  it.each(["topup", "yearly"])("rejects monthly capacity sold as %s before contacting the provider", async mode => {
    const { subscription } = monthlyCloudBilling("org-one", "os-one");
    const { api, fetcher } = setup({ success: true });
    const input = { namespace: "os-one", offer: subscription.offer!, metadata: subscription.metadata!,
      idempotencyKey: "monthly-only", successUrl: "https://app.openship.io/billing", cancelUrl: "https://app.openship.io/billing" };
    await expect(api.createCheckout(mode === "topup"
      ? { ...input, kind: "topup" }
      : { ...input, kind: "subscription", billingInterval: "yearly" })).rejects.toThrow("monthly subscription");
    if (mode === "yearly")
      await expect(api.previewPlanChange("os-one", { ...input, billingInterval: "yearly" })).rejects.toThrow("monthly subscription");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Oblien subscription changes", () => {
  const quote = {
    id: "quote_one", namespace: "os-one", direction: "upgrade", expiresAt: "2026-10-04T10:10:00Z",
    effectiveAt: "2026-10-04T10:00:00Z", billingInterval: "monthly", current: offer,
    next: { ...offer, unitAmount: 2000 }, currency: "usd", unusedTimeCredit: 412, remainingTimeCharge: 833,
    amountDueNow: 421, nextInvoiceAmount: 2000, includedCreditIncrease: 1.123456,
    preservesUsage: true, preservesPurchasedCredits: true,
  };
  const change = {
    id: "change_one", quoteId: quote.id, namespace: "os-one", direction: quote.direction, status: "payment_pending",
    effectiveAt: quote.effectiveAt, current: quote.current, next: quote.next, amountDueNow: quote.amountDueNow,
    currency: "usd", includedCreditIncrease: quote.includedCreditIncrease,
    payment: { status: "open", url: "https://invoice.stripe.com/i/payment", expiresAt: null },
    error: null, cancelable: true, appliedAt: null,
  };
  const input = { offer: quote.next, metadata, billingInterval: "monthly" as const, idempotencyKey: "preview-request" };
  it("delegates all four methods to the official SDK and preserves provider cents and fractional credits", async () => {
    const preview = setup({ success: true, namespace: "os-one", quote });
    expect((await preview.api.previewPlanChange("os-one", input)).quote).toEqual(quote);
    expect(preview.fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/subscription/changes/preview",
      expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(preview.fetcher.mock.calls[0]![1]!.body))).toEqual({ namespace: "os-one", ...input });
    const accept = setup({ success: true, namespace: "os-one", change }, 202);
    expect((await accept.api.changePlan("os-one", { quoteId: quote.id, idempotencyKey: "confirm-request" })).change.status).toBe("payment_pending");
    expect(accept.fetcher).toHaveBeenLastCalledWith("https://api.oblien.com/billing/subscription/changes",
      expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(accept.fetcher.mock.calls.at(-1)![1]!.body))).toEqual({ namespace: "os-one", quoteId: quote.id, idempotencyKey: "confirm-request" });
    await accept.api.getPlanChange("os-one", change.id);
    expect(accept.fetcher).toHaveBeenLastCalledWith("https://api.oblien.com/billing/subscription/changes/change_one?namespace=os-one", expect.objectContaining({ method: "GET" }));
    await accept.api.cancelPlanChange("os-one", change.id, "cancel-request");
    expect(accept.fetcher).toHaveBeenLastCalledWith("https://api.oblien.com/billing/subscription/changes/change_one/cancel",
      expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(accept.fetcher.mock.calls.at(-1)![1]!.body))).toEqual({ namespace: "os-one", idempotencyKey: "cancel-request" });
  });
  it("checks nested namespaces and identities even when the response envelope matches", async () => {
    await expect(setup({ success: true, namespace: "os-one", quote: { ...quote, namespace: "os-two" } }).api.previewPlanChange("os-one", input))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    for (const override of [{ namespace: "os-two" }, { id: "wrong-change" }])
      await expect(setup({ success: true, namespace: "os-one", change: { ...change, ...override } }).api.getPlanChange("os-one", change.id)).rejects.toMatchObject({ statusCode: 502 });
    await expect(setup({ success: true, namespace: "os-one", change: { ...change, quoteId: "wrong-quote" } }).api.changePlan("os-one", { quoteId: quote.id, idempotencyKey: "confirm" }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    await expect(setup({ ...subscription, subscription: { ...subscription.subscription, pendingChange: { ...change, namespace: "os-two" } } }).api.getSubscription("os-one"))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it.each(["http://invoice.stripe.com/i/x", "https://invoice.stripe.com.evil.test/i/x", "https://invoice.stripe.com:8443/i/x", "https://user@invoice.stripe.com/i/x", "javascript:alert(1)"])("rejects unsafe invoice link %s in direct and subscription reads", async url => {
    const unsafe = { ...change, payment: { ...change.payment, url } };
    await expect(setup({ success: true, namespace: "os-one", change: unsafe }).api.getPlanChange("os-one", change.id)).rejects.toMatchObject({ statusCode: 502 });
    await expect(setup({ ...subscription, subscription: { ...subscription.subscription, pendingChange: unsafe } }).api.getSubscription("os-one")).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each(["billing_quote_expired", "billing_quote_changed", "idempotency_conflict", "billing_plan_change_pending", "billing_change_busy", "billing_change_not_cancelable", "plan_change_not_found"])("preserves stable failure %s without payment details", async code => {
    const { api } = setup({ success: false, code, message: "private https://invoice.stripe.com/i/secret" }, 409);
    const failure = await api.getPlanChange("os-one", "private_change").catch(error => error);
    expect(failure).toMatchObject({ statusCode: 409, details: { providerCode: code } });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(JSON.stringify(vi.mocked(errorDiagnostics.warn).mock.calls)).not.toContain("private_change");
  });
});
