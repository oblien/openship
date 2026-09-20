import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: {} as Record<string, unknown>,
  entitlement: vi.fn(), subscription: vi.fn(), balance: vi.fn(), defaults: vi.fn(), mirror: vi.fn(), limits: vi.fn(),
  setQuota: vi.fn(), resetQuota: vi.fn(), setDefaultQuota: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true } }));
vi.mock("@repo/db", () => ({
  repos: { organization: {
    findById: async () => ({ ...h.org }),
    setBillingEntitlement: h.mirror,
  } },
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({ getEntitlement: h.entitlement, getSubscription: h.subscription, getBalance: h.balance, getDefaults: h.defaults }),
  getOblienClient: () => ({ namespaces: { setQuota: h.setQuota, resetQuota: h.resetQuota, setDefaultQuota: h.setDefaultQuota } }),
}));
vi.mock("@repo/platform/engine/lib/cloud-resource-limits", () => ({ syncCloudResourceLimits: h.limits }));
import {
  syncOblienEntitlement, reconcileOblienEntitlement, entitlementQuota,
  assertCloudCanSpend, assertNamespaceHasQuota, ensureOblienDefaultQuota, resetAndRegrant, getQuotaState,
} from "@repo/platform/engine/modules/billing/billing-oblien-quota";

const entitlement = () => ({
  success: true as const, namespace: "os-customer", tierId: "pro", status: "active" as const,
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
  quota: { limit: 3000, used: 420, balance: 2580 },
});
beforeEach(() => {
  vi.resetAllMocks();
  h.org = { id: "org_1", oblienNamespace: "os-customer", planTierId: "free", subscriptionStatus: "credit_exhausted", currentPeriodStart: null, currentPeriodEnd: null };
  h.entitlement.mockResolvedValue(entitlement());
  h.subscription.mockResolvedValue({ namespace: "os-customer", subscription: {
    tierId: "pro", status: "active", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
    billingInterval: "monthly", cancelAtPeriodEnd: false, canceledAt: null,
  } });
  h.balance.mockResolvedValue({ namespace: "os-customer", balance: 2580, blocking: false });
  h.defaults.mockResolvedValue({ autoApply: true, quotaLimit: 0, overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" });
});
describe("Oblien-managed entitlements", () => {
  it("mirrors the paid tier, billing status and exact provider period without writing quotas", async () => {
    const result = await syncOblienEntitlement("org_1");
    expect(result.tier).toBe("pro");
    expect(h.mirror).toHaveBeenCalledWith("org_1", "os-customer", {
      planTierId: "pro", subscriptionStatus: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    expect(h.setQuota).not.toHaveBeenCalled();
    expect(h.resetQuota).not.toHaveBeenCalled();
  });
  it("preserves purchased headroom and uncapped balances", () => {
    expect(entitlementQuota({ ...entitlement(), quota: { limit: 3000, used: -500, balance: 3500 } }))
      .toEqual({ quotaLimit: 3_000_000, quotaUsed: -500_000, quotaRemaining: 3_500_000 });
    expect(entitlementQuota({ ...entitlement(), quota: { limit: null, used: 30, balance: null } }))
      .toEqual({ quotaLimit: null, quotaUsed: 30_000, quotaRemaining: null });
  });
  it("does not rewrite state or grant credits on provider failure", async () => {
    h.entitlement.mockRejectedValue(new Error("upstream unavailable"));
    expect(await reconcileOblienEntitlement("org_1")).toBeNull();
    expect(h.mirror).not.toHaveBeenCalled();
    expect(h.setQuota).not.toHaveBeenCalled();
  });
  it("allows management tokens for exhausted customers but refuses new spending", async () => {
    h.entitlement.mockResolvedValue({ ...entitlement(), status: "credit_exhausted" });
    await expect(assertNamespaceHasQuota("org_1")).resolves.toBeUndefined();
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ statusCode: 402 });
  });
  it("checks the live spend gate even when entitlement reports active", async () => {
    h.balance.mockResolvedValue({ balance: -1, blocking: true });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "CLOUD_BILLING_BLOCKED" });
  });
  it("refuses unexpected unlimited consumer entitlements", async () => {
    h.entitlement.mockResolvedValue({ ...entitlement(), quota: { limit: null, used: 0, balance: null } });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "OBLIEN_NAMESPACE_POLICY_REQUIRED" });
    expect(h.setQuota).not.toHaveBeenCalled();
  });
  it("validates account defaults without replacing provider quotas", async () => {
    await ensureOblienDefaultQuota();
    expect(h.setDefaultQuota).not.toHaveBeenCalled();
    h.defaults.mockResolvedValue({ autoApply: false, quotaLimit: null, onOverdraftAction: "block" });
    await expect(ensureOblienDefaultQuota()).rejects.toMatchObject({ code: "OBLIEN_DEFAULT_POLICY_REQUIRED" });
  });
  it("cannot run a legacy free-credit anniversary reset", async () => {
    await expect(resetAndRegrant("org_1", "pro")).rejects.toMatchObject({ code: "OBLIEN_MANAGED_BILLING" });
    expect(h.resetQuota).not.toHaveBeenCalled();
  });
  it.each([
    { quotaLimit: null }, { quotaLimit: 1000 }, { overdraft: 1 }, { suspendThreshold: null }, { suspendThreshold: 1 }, { autoApply: false },
  ])("requires zero-credit onboarding without altering paid policies: %j", async change => {
    h.defaults.mockResolvedValue({ autoApply: true, quotaLimit: 0, overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces", ...change });
    await expect(ensureOblienDefaultQuota()).rejects.toMatchObject({ code: "OBLIEN_DEFAULT_POLICY_REQUIRED" });
    expect(h.setQuota).not.toHaveBeenCalled();
    expect(h.setDefaultQuota).not.toHaveBeenCalled();
  });
  it.each([0, 500, null])("never grants Cloud deployment from unsubscribed credits (%s)", async limit => {
    h.subscription.mockResolvedValue({ namespace: "os-customer", subscription: null });
    h.entitlement.mockResolvedValue({ ...entitlement(), tierId: null, status: "active", periodStart: null, periodEnd: null, quota: { limit, used: 0, balance: limit } });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ statusCode: 402, code: "CLOUD_BILLING_BLOCKED" });
    expect(h.limits).not.toHaveBeenCalled();
    expect(h.setQuota).not.toHaveBeenCalled();
  });
  it("rejects an owner's paid entitlement echoed under an unsubscribed namespace", async () => {
    h.subscription.mockResolvedValue({ namespace: "os-customer", subscription: null });
    await expect(syncOblienEntitlement("org_1")).rejects.toMatchObject({ code: "OBLIEN_ENTITLEMENT_MISMATCH" });
    expect(h.mirror).not.toHaveBeenCalled();
    expect(h.limits).not.toHaveBeenCalled();
  });
  it("rejects a paid entitlement for a different subscription tier or period", async () => {
    h.entitlement.mockResolvedValue({ ...entitlement(), tierId: "scale" });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "OBLIEN_ENTITLEMENT_MISMATCH" });
    h.entitlement.mockResolvedValue({ ...entitlement(), periodEnd: "2026-11-01T00:00:00Z" });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "OBLIEN_ENTITLEMENT_MISMATCH" });
    expect(h.mirror).not.toHaveBeenCalled();
  });
  it("applies provider resource caps before mirroring paid access", async () => {
    h.limits.mockRejectedValue(new Error("resource policy unavailable"));
    await expect(assertCloudCanSpend("org_1")).rejects.toThrow("resource policy unavailable");
    expect(h.limits).toHaveBeenCalledWith("os-customer", "pro");
    expect(h.mirror).not.toHaveBeenCalled();
  });
  it("allows billing reads without resource-policy writes while keeping the spend gate enforced", async () => {
    h.limits.mockRejectedValue(new Error("resource policy unavailable"));
    await expect(syncOblienEntitlement("org_1", { syncResourceLimits: false })).resolves.toMatchObject({ tier: "pro" });
    await expect(getQuotaState("org_1")).resolves.toEqual({ quotaLimit: 3_000_000, quotaUsed: 420_000, quotaRemaining: 2_580_000 });
    expect(h.limits).not.toHaveBeenCalled();
    await expect(assertCloudCanSpend("org_1")).rejects.toThrow("resource policy unavailable");
    expect(h.limits).toHaveBeenCalledWith("os-customer", "pro");
  });
  it("does not require resource writes to inspect an exhausted account", async () => {
    h.entitlement.mockResolvedValue({ ...entitlement(), status: "credit_exhausted" });
    await assertNamespaceHasQuota("org_1");
    expect(h.limits).not.toHaveBeenCalled();
  });
  it("keeps a cancel-at-period-end subscription usable until its period ends", async () => {
    const state = await h.subscription();
    h.subscription.mockResolvedValue({ ...state, subscription: { ...state.subscription, cancelAtPeriodEnd: true, canceledAt: "2026-09-17T00:00:00Z" } });
    await expect(assertCloudCanSpend("org_1")).resolves.toBeUndefined();
  });
  it.each(["canceled", "past_due"])("retains %s inspection access without allowing spending", async status => {
    const state = await h.subscription();
    h.subscription.mockResolvedValue({ ...state, subscription: { ...state.subscription, status } });
    h.entitlement.mockResolvedValue({ ...entitlement(), status });
    await expect(assertNamespaceHasQuota("org_1")).resolves.toBeUndefined();
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "CLOUD_BILLING_BLOCKED" });
    expect(h.limits).not.toHaveBeenCalled();
  });
  it("accepts a free namespace without a subscription or borrowed paid period", async () => {
    h.subscription.mockResolvedValue({ namespace: "os-customer", subscription: null });
    h.entitlement.mockResolvedValue({ ...entitlement(), tierId: null, periodStart: null, periodEnd: null, status: "credit_exhausted", quota: { limit: 0, used: 0, balance: 0 } });
    await expect(assertNamespaceHasQuota("org_1")).resolves.toBeUndefined();
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "CLOUD_BILLING_BLOCKED" });
  });
});
