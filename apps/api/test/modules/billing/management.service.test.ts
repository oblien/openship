import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import type {
  OblienCheckout,
  OblienSubscription,
} from "@repo/platform/engine/lib/oblien-billing-api";

const h = vi.hoisted(() => ({
  cloud: true,
  enabled: true,
  supported: true,
  covered: false,
  rejectCoverage: false,
  paid: true,
  subscriptions: new Map<string, NonNullable<OblienSubscription>>(),
  checkouts: new Map<
    string,
    { request: OblienCheckout; id: string; expired: boolean; fulfilled: boolean }
  >(),
  lostResponse: false,
  prepare: vi.fn(),
  provider: {
    createCheckout: vi.fn(),
    getCheckout: vi.fn(),
    cancelCheckout: vi.fn(),
    getCatalog: vi.fn(),
    getSubscription: vi.fn(),
    getEntitlement: vi.fn(),
    previewPlanChange: vi.fn(),
    changePlan: vi.fn(),
    cancelSubscription: vi.fn(),
  },
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return h.cloud;
      },
      get BILLING_ENABLED() {
        return h.enabled;
      },
    },
  };
});
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => h.provider,
}));
vi.mock("@repo/platform/engine/lib/oblien-namespace", () => ({ ensureCloudNamespace: h.prepare }));
import { db, repos, schema } from "@repo/db";
import { generateId } from "@repo/core";
import { managementOffer } from "@repo/platform/engine/modules/billing/management-contract";
import type { ManagementPlanId } from "@repo/contracts";
import { OperationError } from "@repo/contracts";
import { Hono } from "hono";
import { OpenshipClient } from "@repo/sdk/client";
import { createShip } from "@repo/sdk/native";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { managementBillingRoutes } from "../../../src/modules/billing/management-billing.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { seedOwner } from "../jobs/_harness";
import { assertManagementActive } from "@repo/platform/engine/modules/billing/management.service";
import {
  getManagement,
  purchaseManagement,
  cancelManagementCheckout,
  assertManagementAccess,
  syncManagementBilling,
  managementNamespace,
  confirmManagementChange,
} from "@repo/platform/engine/modules/billing/management.service";

async function fixture() {
  const organizationId = generateId("org");
  await db
    .insert(schema.organization)
    .values({
      id: organizationId,
      name: "Manage test",
      oblienNamespace: `compute-${organizationId}`,
    });
  return { organizationId, userId: "owner", role: "owner" } as ExecutionContext;
}
async function paidSubscription(ctx: ExecutionContext, servers = 2, included = false, plan: ManagementPlanId = "basic") {
  const namespace = managementNamespace(ctx.organizationId);
  await repos.managementBilling.ensure(ctx.organizationId, namespace);
  await repos.managementBilling.update(ctx.organizationId, { namespaceReady: true });
  const sub: NonNullable<OblienSubscription> = {
    ...managementOffer(ctx.organizationId, namespace, servers, included, plan),
    tierId: "reseller",
    status: "active",
    billingInterval: "monthly",
    cancelAtPeriodEnd: false,
    periodStart: new Date(Date.now() - 86400000).toISOString(),
    periodEnd: new Date(Date.now() + 86400000).toISOString(),
  };
  h.subscriptions.set(namespace, sub);
  return sub;
}
beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = true;
  h.enabled = true;
  h.supported = true;
  h.covered = false;
  h.rejectCoverage = false;
  h.paid = true;
  h.lostResponse = false;
  h.checkouts.clear();
  h.subscriptions.clear();
  h.prepare.mockResolvedValue({});
  h.provider.getCatalog.mockImplementation(async () => ({
    reseller: { serviceOffers: h.supported },
  }));
  h.provider.getSubscription.mockImplementation(async (ns) => ({
    subscription: h.subscriptions.get(ns) ?? null,
  }));
  h.provider.getEntitlement.mockImplementation(async (ns) => {
    if (ns.startsWith("compute-") && h.rejectCoverage) throw Error("Provider unavailable");
    const sub = h.subscriptions.get(ns);
    return {
      namespace: ns,
      tierId: sub ? "reseller" : h.covered ? "pro" : "free",
      billingMode: sub ? "service" : "monthly",
      computeCovered: !sub && h.covered,
      serviceCovered: !!sub && h.paid,
      status: (sub && h.paid) || (!sub && h.covered) ? "active" : "canceled",
      periodStart: sub?.periodStart ?? null,
      periodEnd:
        sub?.periodEnd ?? (h.covered ? new Date(Date.now() + 86400000).toISOString() : null),
    };
  });
  h.provider.createCheckout.mockImplementation(async (request: OblienCheckout) => {
    const key = request.idempotencyKey;
    if (!h.checkouts.has(key))
      h.checkouts.set(key, {
        request: structuredClone(request),
        id: `cs_${h.checkouts.size}`,
        expired: false,
        fulfilled: false,
      });
    const item = h.checkouts.get(key)!;
    expect(request).toEqual(item.request);
    if (h.lostResponse) {
      h.lostResponse = false;
      throw Error("Response lost after provider accepted checkout");
    }
    return { checkoutId: item.id, url: `https://checkout.stripe.com/${item.id}` };
  });
  h.provider.getCheckout.mockImplementation(async (ns, id) => {
    const entry = [...h.checkouts.values()].find((e) => e.id === id)!;
    expect(entry.request.namespace).toBe(ns);
    return {
      checkout: {
        status: entry.expired ? "expired" : entry.fulfilled ? "complete" : "open",
        fulfilled: entry.fulfilled,
      },
    };
  });
  h.provider.cancelCheckout.mockImplementation(async (ns, id) => {
    const entry = [...h.checkouts.values()].find((e) => e.id === id)!;
    expect(entry.request.namespace).toBe(ns);
    if (!entry.fulfilled) entry.expired = true;
    return h.provider.getCheckout(ns, id);
  });
  h.provider.cancelSubscription.mockImplementation(async (ns) => {
    const sub = h.subscriptions.get(ns)!;
    sub.cancelAtPeriodEnd = true;
    return { subscription: sub };
  });
});
describe("hosted management lifecycle with real persistence and locks", () => {
  it("binds the selected support plan to checkout, retry, payment and tenant ownership", async () => {
    const ctx = await fixture(), other = await fixture();
    const selection = { servers: 2, plan: "priority" as const, idempotencyKey: "priority-checkout-key" };
    expect(await purchaseManagement(ctx, selection)).toMatchObject({ kind: "checkout", monthlyCents: 2000 });
    await purchaseManagement(ctx, selection);
    expect(h.checkouts.size).toBe(1);
    const request = [...h.checkouts.values()][0]!.request;
    expect(request.offer).toMatchObject({ unitAmount: 2000, billingMode: "service", credits: 0 });
    expect(JSON.parse(request.metadata!.openship_management!)).toMatchObject({ plan: "priority", supportMonthlyCents: 1500 });
    expect(await getManagement(ctx)).toMatchObject({ active: false, support: null, pendingCheckout: true });
    expect(await getManagement(other)).toMatchObject({ active: false, support: null, pendingCheckout: false });
    await expect(purchaseManagement(ctx, { ...selection, plan: "basic" })).rejects.toMatchObject({ code: "MANAGEMENT_CHECKOUT_PENDING" });
    await cancelManagementCheckout(ctx);
    await paidSubscription(ctx, 2, false, "priority");
    expect(await getManagement(ctx)).toMatchObject({ active: true, support: "priority", serverLimit: 2, subscription: { plan: "priority" } });
    h.paid = false;
    expect(await getManagement(ctx)).toMatchObject({ active: false, support: null });
  });
  it("releases a definitively refused fresh checkout so a later purchase can proceed", async () => {
    const ctx = await fixture();
    h.provider.createCheckout.mockRejectedValueOnce(
      new OperationError("Offer rejected", 400, "OBLIEN_CHECKOUT_REJECTED", {
        checkoutRejected: true,
      }),
    );
    await expect(
      purchaseManagement(ctx, { servers: 2, idempotencyKey: "rejected-checkout-key" }),
    ).rejects.toThrow("Offer rejected");
    expect((await repos.managementBilling.get(ctx.organizationId))?.checkout).toBeNull();
    await expect(
      purchaseManagement(ctx, { servers: 3, idempotencyKey: "corrected-checkout-key" }),
    ).resolves.toMatchObject({ kind: "checkout" });
  });
  it("uses the same scoped billing operations through HTTP and native SDKs", async () => {
    const actor = await seedOwner();
    const app = new Hono()
      .onError(handleApiError)
      .route("/api/health", healthRoutes)
      .route("/api/billing", managementBillingRoutes);
    const remote = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: actor.token,
      organizationId: actor.orgId,
      fetch: ((url, init) => app.request(String(url), init)) as typeof fetch,
    });
    const user = (await repos.user.findById(actor.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: { resolve: async () => ({ user, sessionId: "manage-test" }) },
    });
    const native = await ship.scope({ identity: "verified", organizationId: actor.orgId });
    expect(await remote.billing.getManagement()).toEqual(await native.billing.getManagement());
    for (const override of [{ plan: "admin" }, { monthlyCents: 1 }, { supportMonthlyCents: 0 }, { namespace: managementNamespace("other-org") }]) {
      const rejected = await app.request("/api/billing/manage/checkout", { method: "POST",
        headers: { Authorization: `Bearer ${actor.token}`, "X-Organization-Id": actor.orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ servers: 2, plan: "priority", idempotencyKey: "invalid-support-checkout-key", ...override }) });
      expect(rejected.status).toBe(400);
    }
    expect(h.checkouts.size).toBe(0);
    const selection = { servers: 2, plan: "priority" as const, idempotencyKey: "sdk-shared-checkout-key" };
    expect(await remote.billing.purchaseManagement(selection)).toEqual(
      await native.billing.purchaseManagement(selection),
    );
    expect(h.checkouts.size).toBe(1);
    expect((await remote.billing.cancelManagementCheckout()).pendingCheckout).toBe(false);
    expect((await native.billing.getManagement()).pendingCheckout).toBe(false);
    const foreign = await fixture();
    const outside = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: actor.token,
      organizationId: foreign.organizationId,
      fetch: ((url, init) => app.request(String(url), init)) as typeof fetch,
    });
    await expect(outside.billing.getManagement()).rejects.toMatchObject({ statusCode: 403 });
  });
  it("recovers the immutable checkout after a lost response without duplicate payments", async () => {
    const ctx = await fixture();
    h.lostResponse = true;
    await expect(
      purchaseManagement(ctx, { servers: 2, idempotencyKey: "purchase-000000001" }),
    ).rejects.toThrow(/Response lost/);
    expect((await repos.managementBilling.get(ctx.organizationId))?.checkout?.id).toBeUndefined();
    expect((await getManagement(ctx)).pendingCheckout).toBe(true);
    expect(h.checkouts.size).toBe(1);
    await expect(
      purchaseManagement(ctx, { servers: 3, idempotencyKey: "purchase-000000002" }),
    ).rejects.toMatchObject({ code: "MANAGEMENT_CHECKOUT_PENDING" });
    expect((await cancelManagementCheckout(ctx)).pendingCheckout).toBe(false);
    await purchaseManagement(ctx, { servers: 3, idempotencyKey: "purchase-000000003" });
    expect(h.checkouts.size).toBe(2);
    expect(h.prepare).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent purchases and isolates tenants", async () => {
    const a = await fixture(),
      b = await fixture();
    await Promise.all([
      purchaseManagement(a, { servers: 2, idempotencyKey: "same-purchase-key1" }),
      purchaseManagement(a, { servers: 2, idempotencyKey: "same-purchase-key1" }),
      purchaseManagement(b, { servers: 2, idempotencyKey: "same-purchase-key1" }),
    ]);
    expect(h.checkouts.size).toBe(2);
    await cancelManagementCheckout(a);
    expect((await getManagement(b)).pendingCheckout).toBe(true);
  });
  it("keeps existing access available with sales disabled and never grants unpaid access", async () => {
    const ctx = await fixture();
    await paidSubscription(ctx);
    h.supported = false;
    expect(await getManagement(ctx)).toMatchObject({
      active: true,
      serverLimit: 2,
      purchasesAvailable: false,
    });
    await expect(
      purchaseManagement(ctx, { servers: 3, idempotencyKey: "purchase-000000004" }),
    ).rejects.toMatchObject({ code: "MANAGEMENT_CHECKOUT_UNAVAILABLE" });
    h.paid = false;
    expect((await getManagement(ctx)).active).toBe(false);
    await expect(assertManagementAccess(ctx.organizationId)).rejects.toMatchObject({
      code: "MANAGEMENT_PLAN_REQUIRED",
    });
  });
  it("includes two servers with Cloud, and expires access without modifying any server", async () => {
    const ctx = await fixture();
    h.covered = true;
    expect((await getManagement(ctx)).serverLimit).toBe(2);
    const ids = [generateId("srv"), generateId("srv")];
    for (const id of ids)
      await db
        .insert(schema.servers)
        .values({ id, organizationId: ctx.organizationId, sshHost: "host.example.test" });
    await expect(assertManagementActive(ctx.organizationId)).resolves.toMatchObject({ limit: 2 });
    await expect(assertManagementAccess(ctx.organizationId, ids[0])).resolves.toBeUndefined();
    await expect(assertManagementAccess(ctx.organizationId)).rejects.toMatchObject({
      code: "MANAGEMENT_PLAN_REQUIRED",
    });
    const other = await fixture();
    await expect(assertManagementAccess(other.organizationId, ids[0])).rejects.toMatchObject({
      code: "MANAGEMENT_PLAN_REQUIRED",
    });
    h.covered = false;
    await getManagement(ctx);
    await expect(assertManagementAccess(ctx.organizationId, ids[0])).rejects.toMatchObject({
      code: "MANAGEMENT_PLAN_REQUIRED",
    });
    expect(
      (await repos.server.listByOrganization(ctx.organizationId)).map((s) => s.id).sort(),
    ).toEqual(ids.sort());
  });
  it("stops a duplicate base renewal on Cloud purchase, but preserves the already paid period", async () => {
    const ctx = await fixture();
    await paidSubscription(ctx);
    h.covered = true;
    await syncManagementBilling(ctx.organizationId);
    expect(h.provider.cancelSubscription).toHaveBeenCalledWith(
      managementNamespace(ctx.organizationId),
    );
    expect((await getManagement(ctx)).serverLimit).toBe(2);
  });
  it("does not increase charges after losing Cloud coverage or interpret provider errors as cancellation", async () => {
    const ctx = await fixture();
    await paidSubscription(ctx, 4, true);
    h.rejectCoverage = true;
    await expect(syncManagementBilling(ctx.organizationId)).rejects.toThrow(/Provider unavailable/);
    expect(h.provider.cancelSubscription).not.toHaveBeenCalled();
    h.rejectCoverage = false;
    await syncManagementBilling(ctx.organizationId);
    expect((await getManagement(ctx)).serverLimit).toBe(4);
    expect(h.provider.changePlan).not.toHaveBeenCalled();
  });
  it("rechecks connected-server count before confirming a reduction", async () => {
    const ctx = await fixture();
    await paidSubscription(ctx, 3);
    h.provider.previewPlanChange.mockImplementation(async (_ns, request) => ({
      quote: {
        id: "quote_saved",
        next: request.offer,
        amountDueNow: 0,
        effectiveAt: new Date(Date.now() + 86400000).toISOString(),
      },
    }));
    await purchaseManagement(ctx, { servers: 2, idempotencyKey: "purchase-000000005" });
    for (let i = 0; i < 3; i++)
      await db
        .insert(schema.servers)
        .values({
          id: generateId("srv"),
          organizationId: ctx.organizationId,
          sshHost: "host.example.test",
        });
    await expect(confirmManagementChange(ctx, { quoteId: "quote_saved" })).rejects.toMatchObject({
      code: "MANAGEMENT_SERVERS_IN_USE",
    });
    expect(h.provider.changePlan).not.toHaveBeenCalled();
  });
  it("reserves a scheduled smaller allowance while keeping existing paid servers available", async () => {
    const ctx = await fixture();
    const sub = await paidSubscription(ctx, 3);
    const next = managementOffer(
      ctx.organizationId,
      managementNamespace(ctx.organizationId),
      2,
      false,
    );
    h.provider.previewPlanChange.mockResolvedValue({
      quote: { id: "quote_smaller", next: next.offer, amountDueNow: 0, effectiveAt: sub.periodEnd },
    });
    await purchaseManagement(ctx, { servers: 2, idempotencyKey: "scheduled-reduction-key" });
    sub.pendingChange = {
      id: "change_smaller",
      quoteId: "quote_smaller",
      status: "scheduled",
      next: next.offer,
      effectiveAt: sub.periodEnd,
    } as NonNullable<OblienSubscription>["pendingChange"];
    const ids = [generateId("srv"), generateId("srv")];
    for (const id of ids)
      await db
        .insert(schema.servers)
        .values({ id, organizationId: ctx.organizationId, sshHost: "host.example.test" });
    await getManagement(ctx);
    await expect(assertManagementAccess(ctx.organizationId, ids[0])).resolves.toBeUndefined();
    await expect(assertManagementAccess(ctx.organizationId)).rejects.toMatchObject({
      code: "MANAGEMENT_PLAN_REQUIRED",
    });
  });
});
