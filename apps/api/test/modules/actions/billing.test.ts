import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const provider = vi.hoisted(() => ({
  cloud: true,
  enabled: false,
  createCheckout: vi.fn(),
  getCheckout: vi.fn(),
  getMeteredPricing: vi.fn(),
  getBalance: vi.fn(),
  getEntitlement: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get BILLING_ENABLED() {
        return provider.enabled;
      },
      OBLIEN_CLIENT_ID: "test-actions-id",
      OBLIEN_CLIENT_SECRET: "test-actions-secret",
      get CLOUD_MODE() {
        return provider.cloud;
      },
    },
  };
});
vi.mock("@repo/platform/engine/lib/oblien-client", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/oblien-client")>()),
  getOblienBillingApi: () => provider,
}));

vi.mock("@repo/platform/engine/modules/actions/billing-namespace", () => ({
  ensureActionsBillingNamespace: provider.prepare,
  ensureFundedActionRunners: vi.fn(),
}));

import { db, repos, schema, seedOwner, type SeededOwner } from "../jobs/_harness";
import { actionDepositUnits, actionCreditUnits, generateId, PRICING } from "@repo/core";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { actionBillingNamespace } from "@repo/platform/engine/modules/actions/billing";
import { actionsBillingRoutes } from "../../../src/modules/billing/actions-billing.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { healthRoutes } from "../../../src/modules/health/health.routes";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/billing", actionsBillingRoutes);
const fetcher = ((url, init) => app.request(url as string, init)) as typeof fetch;
async function clients(actor: SeededOwner, org = actor.orgId) {
  const user = (await repos.user.findById(actor.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: { resolve: async () => ({ user, sessionId: "actions-billing" }) },
  });
  return [
    (await ship.scope({ identity: "verified", organizationId: org })).billing,
    new OpenshipClient({
      baseUrl: "http://actions.test",
      token: actor.token,
      organizationId: org,
      fetch: fetcher,
    }).billing,
  ];
}
async function purchase(actor: SeededOwner) {
  const id = generateId("acredit");
  await repos.actionBilling.createPurchase(
    {
      id,
      organizationId: actor.orgId,
      idempotencyKey: id,
      priceCents: 500,
      request: { private: "saved-provider-request" },
    },
    actionBillingNamespace(actor.orgId),
  );
  return repos.actionBilling.recordCheckout(
    actor.orgId,
    id,
    generateId("checkout"),
    "sealed-private-url",
  );
}
beforeEach(() => {
  provider.cloud = true;
  vi.resetAllMocks();
  provider.enabled = false;
  provider.getMeteredPricing.mockResolvedValue({
    success: true,
    credits_per_dollar: 100,
    rate_card_id: "live-meter",
    rates: { cpu_per_min: 1.5, memory_per_gb_min: 0.2, disk_per_gb: 0, network_per_gb: 0.15 },
  });
  provider.getBalance.mockImplementation(async (namespace) => ({
    success: true,
    namespace,
    balance: 443.25,
    blocking: false,
    billingMode: "metered",
  }));
  provider.getEntitlement.mockImplementation(async (namespace) => ({
    success: true,
    namespace,
    billingMode: "metered",
    capacity: null,
    quota: { used: 56.75, limit: 500 },
  }));
});
afterEach(() => {
  provider.cloud = true;
});

describe("Actions budget through native and HTTP billing permissions", () => {
  it("returns the approved catalog without provisioning an account or exposing payment credentials", async () => {
    const owner = await seedOwner(),
      other = await seedOwner();
    const payment = await purchase(owner);
    await repos.actionBilling.reconcilePurchase(
      owner.orgId,
      payment.id,
      payment.checkoutId!,
      actionDepositUnits(500),
      "completed",
      86_400,
    );
    for (const client of await clients(owner)) {
      const state = await client.getActionsBudget();
      expect(state).toMatchObject({
        currency: "usd",
        unitsPerDollar: 60_000_000,
        purchasesAvailable: false,
        balance: {
          fundedUnits: actionDepositUnits(500),
          availableUnits: actionCreditUnits(443.25),
          spentUnits: actionCreditUnits(56.75),
          status: "ready",
        },
        pricing: {
          version: PRICING.actions.version,
          maxParallel: PRICING.actions.maxParallel,
          depositsCents: PRICING.actions.depositsCents,
          runners: PRICING.actions.runners.map((r) => ({
            ...r,
            estimatedUnitsPerMinute: actionCreditUnits(
              r.cpuCores * 1.5 + (r.memoryMb / 1024) * 0.2,
            ),
          })),
        },
        purchases: [
          {
            id: payment.id,
            priceCents: 500,
            fundedUnits: actionDepositUnits(500),
            status: "completed",
          },
        ],
      });
      const serialized = JSON.stringify(state);
      for (const secret of [
        payment.checkoutId!,
        "sealed-private-url",
        "saved-provider-request",
        actionBillingNamespace(owner.orgId),
      ])
        expect(serialized).not.toContain(secret);
    }
    for (const client of await clients(other)) {
      expect(await client.getActionsBudget()).toMatchObject({
        balance: { fundedUnits: 0, availableUnits: 0 },
        purchases: [],
      });
    }
    expect(await repos.actionBilling.budget(other.orgId)).toBeUndefined();
    expect(provider.createCheckout).not.toHaveBeenCalled();
    expect(provider.getCheckout).not.toHaveBeenCalled();
  });

  it("keeps checkout disabled when Cloud payments are not configured", async () => {
    const owner = await seedOwner();
    for (const client of await clients(owner)) {
      await expect(
        client.createActionsCheckout({ amountCents: 500, idempotencyKey: "payment-attempt" }),
      ).rejects.toMatchObject({ statusCode: 503, code: "ACTIONS_CHECKOUT_UNAVAILABLE" });
      await expect(
        client.resumeActionsCheckout({ purchaseId: "acredit_missing" }),
      ).rejects.toMatchObject({ statusCode: 503, code: "ACTIONS_CHECKOUT_UNAVAILABLE" });
    }
    expect(await repos.actionBilling.purchases(owner.orgId)).toEqual([]);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("opens only an approved deposit on the enabled path with a stable payment identity", async () => {
    provider.enabled = true;
    const owner = await seedOwner();
    provider.createCheckout.mockResolvedValue({
      checkoutId: "checkout-open",
      url: "https://checkout.stripe.com/actions-test",
      success: true,
    });
    for (const client of await clients(owner)) {
      expect((await client.getActionsBudget()).purchasesAvailable).toBe(true);
      provider.getCheckout.mockImplementation(async (namespace) => ({
        namespace,
        checkout: {
          id: "checkout-open",
          kind: "topup",
          status: "open",
          paymentStatus: "unpaid",
          fulfilled: false,
          fulfillmentStatus: "pending",
          namespaceCreditsGranted: 0,
        },
      }));
      await expect(
        client.createActionsCheckout({ amountCents: 500, idempotencyKey: "same-deposit" }),
      ).resolves.toMatchObject({ checkoutUrl: "https://checkout.stripe.com/actions-test" });
      await expect(
        client.createActionsCheckout({ amountCents: 1, idempotencyKey: "fake-deposit" }),
      ).rejects.toMatchObject({ code: "ACTIONS_DEPOSIT_INVALID" });
    }
    expect(provider.createCheckout).toHaveBeenCalledOnce();
    expect(provider.createCheckout.mock.calls[0]![0]).toMatchObject({
      namespace: actionBillingNamespace(owner.orgId),
      offer: { unitAmount: 500, credits: 500 },
    });
    expect((await repos.actionBilling.budget(owner.orgId))!.fundedUnits).toBe(0);
    expect(await repos.actions.listRunners(owner.orgId)).toEqual([]);
  });

  it("keeps deposits visible but does not invent balances or estimates during provider errors", async () => {
    const owner = await seedOwner();
    await purchase(owner);
    provider.getBalance.mockRejectedValue(new Error("Provider unavailable"));
    provider.getMeteredPricing.mockRejectedValue(new Error("Pricing unavailable"));
    provider.enabled = true;
    for (const client of await clients(owner)) {
      const state = await client.getActionsBudget();
      expect(state.balance).toMatchObject({
        availableUnits: null,
        spentUnits: null,
        blocking: true,
        status: "unavailable",
      });
      expect(state.pricing.meter).toBeNull();
      expect(state.pricing.runners.every((r) => r.estimatedUnitsPerMinute === null)).toBe(true);
      expect(state.purchasesAvailable).toBe(false);
      expect(state.purchases).toHaveLength(1);
      await expect(
        client.createActionsCheckout({ amountCents: 500, idempotencyKey: "retry-payment" }),
      ).rejects.toThrow();
    }
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("requires billing read separately from workflow authority, and write separately from read", async () => {
    const owner = await seedOwner(),
      member = await seedOwner({ bound: false });
    await db
      .update(schema.organization)
      .set({ isTeam: true })
      .where(eq(schema.organization.id, owner.orgId));
    await db.insert(schema.member).values({
      id: generateId("member"),
      organizationId: owner.orgId,
      userId: member.userId,
      role: "restricted",
    });
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: member.userId,
      resourceType: "job",
      resourceId: "*",
      permissions: ["admin"],
      grantedByUserId: owner.userId,
    });
    for (const client of await clients(member, owner.orgId)) {
      await expect(client.getActionsBudget()).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        client.getActionsPurchase({ purchaseId: "acredit_missing" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: member.userId,
      resourceType: "billing",
      resourceId: "*",
      permissions: ["read"],
      grantedByUserId: owner.userId,
    });
    for (const client of await clients(member, owner.orgId)) {
      expect((await client.getActionsBudget()).currency).toBe("usd");
      await expect(
        client.createActionsCheckout({ amountCents: 500, idempotencyKey: "payment-attempt" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        client.resumeActionsCheckout({ purchaseId: "acredit_missing" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it("reconciles only the owner's verified receipt and never funds from a browser return", async () => {
    const owner = await seedOwner(),
      other = await seedOwner();
    const payment = await purchase(owner);
    for (const client of await clients(other)) {
      await expect(client.getActionsPurchase({ purchaseId: payment.id })).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    expect(provider.getCheckout).not.toHaveBeenCalled();
    provider.getCheckout.mockResolvedValue({
      namespace: actionBillingNamespace(owner.orgId),
      checkout: {
        id: payment.checkoutId,
        kind: "topup",
        status: "complete",
        fulfilled: true,
        fulfillmentStatus: "completed",
        paymentStatus: "paid",
        namespaceCreditsGranted: 500,
      },
    });
    for (const client of await clients(owner)) {
      expect(await client.getActionsPurchase({ purchaseId: payment.id })).toMatchObject({
        id: payment.id,
        fundedUnits: actionDepositUnits(500),
        status: "completed",
      });
      expect((await client.getActionsBudget()).balance.fundedUnits).toBe(actionDepositUnits(500));
    }
    expect(provider.getCheckout).toHaveBeenCalledWith(
      actionBillingNamespace(owner.orgId),
      payment.checkoutId,
    );
  });

  it("does not let an organization-bound local credential borrow an owner's Cloud identity", async () => {
    provider.cloud = false;
    const owner = await seedOwner();
    const response = await app.request("/api/billing/actions", { headers: owner.auth });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("requires authentication on every new billing path", async () => {
    for (const [method, path] of [
      ["GET", "actions"],
      ["GET", "actions/purchase"],
      ["POST", "actions/checkout"],
      ["POST", "actions/checkout/resume"],
    ]) {
      const response = await app.request(`/api/billing/${path}`, { method });
      expect(response.status).toBe(401);
    }
  });
});
