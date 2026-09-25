import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingPlanGrantRepo, createDatabase, schema, type DatabaseConnection } from "@repo/db/factory";
import { PRICING, planLimits, resolvePlan } from "@repo/core";
import type { OblienBillingApi, OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
import { runPlanGrantCommand, type PlanGrantCommand } from "@repo/platform/engine/modules/billing/billing-plan-grant.operator";
import { planGrantPeriod, readProviderBilling, reconcilePlanGrant } from "@repo/platform/engine/modules/billing/billing-plan-grants";

vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true } }));

let connection: DatabaseConnection;
let grants: ReturnType<typeof createBillingPlanGrantRepo>;
const namespace = "os-test-customer";
const organizationId = "org-test-customer";
const now = new Date("2026-09-25T14:00:00.000Z");
const command: PlanGrantCommand = {
  command: "grant", email: "customer@example.com", plan: "pro", expiresAt: null,
  operator: "test-operator", reason: "Partner account", dryRun: false,
};
let subscription: OblienSubscription;
let used: number;
let policy: { quotaLimit: number; overdraft: number; suspendThreshold: number; onOverdraftAction: "stop_workspaces" | "block" };
let lastReset: string | null;
const syncLimits = vi.fn(async () => {});
const provider = {
  getSubscription: vi.fn(async (slug: string) => ({ success: true as const, namespace: slug, subscription })),
  getEntitlement: vi.fn(async (slug: string) => ({
    success: true as const, namespace: slug, tierId: subscription?.tierId ?? "free",
    status: policy.quotaLimit + policy.overdraft > used ? "active" as const : "credit_exhausted" as const,
    periodStart: subscription?.periodStart ?? null, periodEnd: subscription?.periodEnd ?? null,
    quota: { limit: policy.quotaLimit, used, balance: policy.quotaLimit + policy.overdraft - used },
  })),
  getBalance: vi.fn(async (slug: string) => ({
    success: true as const, namespace: slug, balance: policy.quotaLimit + policy.overdraft - used,
    blocking: policy.quotaLimit + policy.overdraft <= used,
  })),
  setPolicy: vi.fn(async (slug: string, next: typeof policy) => {
    policy = { ...next };
    return { success: true as const, namespace: slug, service: "workspace_vm" as const, ...policy };
  }),
  resetQuota: vi.fn(async (slug: string, periodEnd: string) => {
    const applied = lastReset === null || periodEnd > lastReset;
    if (applied) { used = 0; lastReset = periodEnd; }
    return { success: true as const, namespace: slug, applied };
  }),
};
const billing = provider as unknown as OblienBillingApi;
const lockKeys = vi.fn();
async function lock<T>(key: string, work: () => Promise<T>): Promise<T> {
  lockKeys(key);
  return work();
}
const run = (args: Partial<PlanGrantCommand> = {}, date = now) => runPlanGrantCommand({ ...command, ...args }, { grants, billing, lock, syncLimits, now: date });
const reconcile = async (date = now) => reconcilePlanGrant({
  organizationId, namespace, grants, billing, syncLimits, now: date, state: await readProviderBilling(billing, namespace),
});

beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  grants = createBillingPlanGrantRepo(connection.db);
}, 60_000);
afterAll(async () => connection?.close());
beforeEach(async () => {
  vi.clearAllMocks();
  subscription = null;
  used = 0.0719;
  policy = { quotaLimit: 0, overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" };
  lastReset = null;
  await connection.db.delete(schema.organization);
  await connection.db.delete(schema.user);
  await connection.db.insert(schema.user).values({ id: "test-user", name: "Customer", email: command.email });
  await connection.db.insert(schema.organization).values({ id: organizationId, name: "Customer's workspace", oblienNamespace: namespace });
  await connection.db.insert(schema.member).values({ id: "test-member", userId: "test-user", organizationId, role: "owner" });
});

describe("complimentary plan operator and reconciliation", () => {
  it("previews the actual owned workspace without creating a grant or credit writes", async () => {
    expect(await run({ dryRun: true, email: "CUSTOMER@example.com" })).toMatchObject({
      organizationId, namespace, action: "grant", charge: 0, monthlyCredits: 3000, expiresAt: null,
    });
    expect(await grants.current(organizationId)).toBeNull();
    expect(provider.setPolicy).not.toHaveBeenCalled();
    expect(provider.resetQuota).not.toHaveBeenCalled();
  });

  it("issues Pro with its saved allowance and caps, while the provider subscription stays null", async () => {
    expect(await run()).toMatchObject({ plan: "pro", charge: 0, monthlyCredits: 3000, spendingBlocked: false, nextRenewal: "2026-10-25T14:00:00.000Z", expiresAt: null });
    const row = (await grants.current(organizationId))!;
    expect(row).toMatchObject({ grantedBy: "test-operator", reason: "Partner account", limits: planLimits("pro") });
    expect(row.appliedPeriodEnd?.toISOString()).toBe("2026-10-25T14:00:00.000Z");
    expect((await grants.ownedOrganizations(command.email))[0]?.tier).toBe("pro");
    expect(syncLimits).toHaveBeenCalledWith(namespace, "pro", resolvePlan("pro").oblienLimits);
    expect(subscription).toBeNull();
    expect(lockKeys).toHaveBeenCalledWith(`billing:entitlement:${organizationId}`);
  });

  it("reuses a grant without resetting consumption or adding credits", async () => {
    const first = await run();
    used = 42.5;
    const second = await run();
    expect(second).toMatchObject({ grantId: "grantId" in first ? first.grantId : undefined, plan: "pro" });
    expect(used).toBe(42.5);
    expect(provider.resetQuota).toHaveBeenCalledTimes(1);
    expect(provider.setPolicy).toHaveBeenCalledTimes(1);
  });

  it("retries a crash after provider reset without refilling credits consumed since the crash", async () => {
    const write = vi.spyOn(grants, "markApplied").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(run()).rejects.toThrow("database unavailable");
    expect((await grants.current(organizationId))?.appliedPeriodEnd).toBeNull();
    used = 125.25;
    await run();
    expect(used).toBe(125.25);
    expect(provider.resetQuota).toHaveBeenNthCalledWith(1, namespace, "2026-10-25T14:00:00.000Z");
    expect(provider.resetQuota).toHaveBeenNthCalledWith(2, namespace, "2026-10-25T14:00:00.000Z");
    write.mockRestore();
  });

  it("renews the saved monthly allowance once even after catalog prices/allowances change", async () => {
    await run();
    used = 2990;
    const catalog = PRICING.plans.find(plan => plan.id === "pro")!;
    const original = catalog.billing.creditsPerCycle;
    catalog.billing.creditsPerCycle = 5000;
    try {
      const future = new Date("2026-10-25T14:01:00Z");
      expect((await reconcile(future)).grant?.offer.credits).toBe(3000);
      expect(used).toBe(0);
      used = 17;
      await reconcile(future);
      expect(used).toBe(17);
      expect(provider.resetQuota).toHaveBeenCalledTimes(2);
      expect(policy.quotaLimit).toBe(3000);
    } finally { catalog.billing.creditsPerCycle = original; }
  });

  it("revokes the budget and caps, retains history, and safely repeats revocation", async () => {
    await run();
    used = 35;
    expect(await run({ command: "revoke" })).toMatchObject({ plan: "free", grantId: null, spendingBlocked: true });
    expect(await grants.current(organizationId)).toBeNull();
    expect(await grants.latest(organizationId)).toMatchObject({ revokedBy: "test-operator", releasedAt: now, releaseReason: "revoked" });
    expect(syncLimits).toHaveBeenLastCalledWith(namespace, "free", expect.any(Object));
    expect(used).toBe(35);
    await run({ command: "revoke" });
    expect(provider.setPolicy).toHaveBeenCalledTimes(2);
    expect(provider.resetQuota).toHaveBeenCalledTimes(1);
  });

  it("stops an expiring grant instead of granting another cycle", async () => {
    const expiry = new Date("2026-10-01T00:00:00Z");
    await run({ expiresAt: expiry });
    expect(provider.resetQuota).toHaveBeenCalledWith(namespace, expiry.toISOString());
    expect((await reconcile(expiry)).grant).toBeNull();
    expect((await grants.latest(organizationId))?.releaseReason).toBe("expired");
    expect(provider.resetQuota).toHaveBeenCalledTimes(1);
  });

  it("keeps failed revocation pending so reconciliation can finish the provider cleanup", async () => {
    await run();
    provider.setPolicy.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(run({ command: "revoke" })).rejects.toThrow("provider unavailable");
    expect(await grants.current(organizationId)).toMatchObject({ revokedAt: now, releasedAt: null });
    expect((await reconcile()).grant).toBeNull();
    expect(await grants.current(organizationId)).toBeNull();
    expect(policy.quotaLimit).toBe(0);
  });

  it("does not mark a grant applied when the provider did not confirm its allowance", async () => {
    provider.setPolicy.mockResolvedValueOnce({ success: true, namespace, service: "workspace_vm", ...policy });
    await expect(run()).rejects.toMatchObject({ code: "BILLING_PLAN_GRANT_UNCONFIRMED" });
    expect((await grants.current(organizationId))?.appliedPeriodEnd).toBeNull();
    expect(provider.resetQuota).not.toHaveBeenCalled();
    expect((await grants.ownedOrganizations(command.email))[0]?.tier).toBe("free");
  });

  it("refuses a workspace not owned by the email without provider writes", async () => {
    await expect(run({ organizationId: "another-customer" })).rejects.toMatchObject({ code: "BILLING_GRANT_WORKSPACE_REQUIRED" });
    expect(provider.setPolicy).not.toHaveBeenCalled();
  });

  it("rejects duplicate email identities and never chooses a random user", async () => {
    await connection.db.insert(schema.user).values({ id: "other-user", name: "Other", email: "CUSTOMER@example.com" });
    await connection.db.insert(schema.organization).values({ id: "other-org", name: "Other workspace" });
    await connection.db.insert(schema.member).values({ id: "other-member", userId: "other-user", organizationId: "other-org", role: "owner" });
    await expect(run()).rejects.toMatchObject({ code: "BILLING_GRANT_USER_AMBIGUOUS" });
    expect(provider.getSubscription).not.toHaveBeenCalled();
  });

  it("refuses to replace a hosted subscription with a complimentary plan", async () => {
    subscription = { tierId: "pro", status: "active", billingInterval: "monthly", periodStart: now.toISOString(), periodEnd: "2026-10-25T14:00:00Z", cancelAtPeriodEnd: false, canceledAt: null };
    await expect(run()).rejects.toMatchObject({ code: "BILLING_GRANT_SUBSCRIPTION_EXISTS" });
    expect(await grants.current(organizationId)).toBeNull();
    expect(provider.setPolicy).not.toHaveBeenCalled();
  });

  it("permanently retires a grant when a hosted subscription takes over without touching its budget", async () => {
    await run();
    subscription = { tierId: "pro", status: "active", billingInterval: "monthly", periodStart: now.toISOString(), periodEnd: "2026-10-25T14:00:00Z", cancelAtPeriodEnd: false, canceledAt: null };
    expect((await reconcile()).grant).toBeNull();
    subscription = null;
    expect((await reconcile()).grant).toBeNull();
    expect((await grants.latest(organizationId))?.releaseReason).toBe("hosted_subscription");
    expect(provider.setPolicy).toHaveBeenCalledTimes(1);
  });

  it("does not grant access from a mismatched provider namespace or a failed read", async () => {
    provider.getSubscription.mockResolvedValueOnce({ success: true, namespace: "foreign", subscription: null });
    await expect(run()).rejects.toMatchObject({ code: "OBLIEN_ENTITLEMENT_MISMATCH" });
    provider.getSubscription.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(run()).rejects.toThrow("provider unavailable");
    expect(await grants.current(organizationId)).toBeNull();
    expect(provider.setPolicy).not.toHaveBeenCalled();
  });

  it("does not accept a different plan or silently extend a fixed-duration grant on retry", async () => {
    await run();
    await expect(run({ plan: "team" })).rejects.toMatchObject({ code: "BILLING_GRANT_CONFLICT" });
    await expect(run({ expiresAt: new Date("2026-11-01T00:00:00Z") })).rejects.toMatchObject({ code: "BILLING_GRANT_CONFLICT" });
    expect(provider.resetQuota).toHaveBeenCalledTimes(1);
  });

  it("has a database constraint against simultaneous unreleased grants", async () => {
    await run();
    const row = (await grants.current(organizationId))!;
    await expect(grants.create({ ...row, id: "duplicate-grant" })).rejects.toThrow();
    expect((await grants.current(organizationId))?.id).toBe(row.id);
  });
});

it("handles monthly grants across leap years and recovers the original day after a short month", () => {
  const created = new Date("2028-01-31T16:45:12.345Z");
  expect(planGrantPeriod(created, new Date("2028-02-29T16:45:12.344Z"))).toEqual({ start: created, end: new Date("2028-02-29T16:45:12.345Z") });
  expect(planGrantPeriod(created, new Date("2028-02-29T16:45:12.345Z"))).toEqual({ start: new Date("2028-02-29T16:45:12.345Z"), end: new Date("2028-03-31T16:45:12.345Z") });
});
