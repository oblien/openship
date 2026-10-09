import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type {
  OblienBillingApi,
  OblienCheckout,
} from "@repo/platform/engine/lib/oblien-billing-api";

type Receipt = Awaited<ReturnType<OblienBillingApi["getCheckout"]>>;
const provider = vi.hoisted(() => ({
  cloud: true,
  secret: "test-actions-webhook-secret",
  receipts: new Map<string, Receipt>(),
  createCheckout: vi.fn(),
  getCheckout: vi.fn(),
  hostingSync: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return provider.cloud;
      },
      get OBLIEN_WEBHOOK_SECRET() {
        return provider.secret;
      },
    },
  };
});
vi.mock("@repo/platform/engine/lib/oblien-client", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/oblien-client")>()),
  getOblienBillingApi: () => provider,
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/billing/billing-oblien-quota")
  >()),
  withCloudBillingLock: provider.hostingSync,
}));

import { db, repos, schema, seedOwner, installFakeRunner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { actionDepositUnits, generateId } from "@repo/core";
import { actionBillingNamespace } from "@repo/platform/engine/modules/actions/billing";
import { runActionsPaymentReconcile } from "@repo/platform/engine/modules/actions/billing-application";
import { handleOblienWebhook } from "@repo/platform/engine/modules/billing/oblien-webhook.service";
import { scheduleBillingAnniversary } from "@repo/platform/engine/modules/billing/billing-anniversary.cron";

beforeEach(async () => {
  provider.cloud = true;
  provider.receipts.clear();
  provider.hostingSync.mockReset();
  provider.createCheckout.mockReset().mockRejectedValue(new Error("Unexpected checkout creation"));
  provider.getCheckout.mockReset().mockImplementation(async (namespace: string, id: string) => {
    const receipt = provider.receipts.get(id);
    if (!receipt || receipt.namespace !== namespace)
      throw new Error("Checkout not in this namespace");
    return structuredClone(receipt);
  });
  // Each case owns fresh orders in the harness's isolated in-memory database.
  await db.update(schema.actionCreditPurchase).set({ nextCheckAt: null });
});
afterEach(() => {
  provider.cloud = true;
  vi.restoreAllMocks();
});

async function order(options: { saveCheckout?: boolean; net?: number } = {}) {
  const actor = await seedOwner();
  const id = generateId("acredit"),
    checkoutId = generateId("checkout");
  const namespace = actionBillingNamespace(actor.orgId);
  const request: OblienCheckout = {
    namespace,
    kind: "topup",
    idempotencyKey: `openship-actions:${id}`,
    offer: {
      reference: "actions-deposit-v1-500",
      name: "Actions funds",
      currency: "usd",
      unitAmount: 500,
      credits: 500,
    },
    metadata: { product: "openship-actions", organizationId: actor.orgId, orderId: id },
    successUrl: `https://app.test/actions/billing?purchase=${id}`,
    cancelUrl: `https://app.test/actions/billing?purchase=${id}&cancelled=1`,
  };
  await repos.actionBilling.createPurchase(
    { id, organizationId: actor.orgId, idempotencyKey: id, priceCents: 500, request },
    namespace,
  );
  if (options.saveCheckout !== false)
    await repos.actionBilling.recordCheckout(actor.orgId, id, checkoutId, "encrypted-test-url");
  const receipt = {
    success: true,
    namespace,
    checkout: {
      id: checkoutId,
      kind: "topup",
      status: "complete",
      paymentStatus: "paid",
      fulfilled: true,
      fulfillmentStatus: "completed",
      namespaceCreditsGranted: options.net ?? 500,
    },
  } as Receipt;
  provider.receipts.set(checkoutId, receipt);
  return { actor, id, checkoutId, namespace, request, receipt };
}

async function deliver(
  namespace: string,
  data: Record<string, unknown> = {},
  event = "payment.succeeded",
  id = generateId("evt"),
  signed = true,
) {
  const body = JSON.stringify({ id, event, data: { namespace, ...data } });
  const signature = createHmac("sha256", signed ? provider.secret : "wrong-secret")
    .update(body)
    .digest("hex");
  return { id, result: await handleOblienWebhook(body, signature, id) };
}

describe("signed Actions payment delivery and recurring recovery", () => {
  it("queues a signed event without funding from its payload and settles through the existing recurring runner", async () => {
    const f = await order();
    await repos.actionBilling.reconcilePurchase(f.actor.orgId, f.id, f.checkoutId, 0, "open", 300);
    const event = await deliver(f.namespace, {
      checkoutId: f.checkoutId,
      kind: "topup",
      metadata: { orderId: f.id },
      namespaceCredits: 9_000_000,
      amount: { unitAmount: 999_999, currency: "usd" },
    });
    expect(event.result.status).toBe(200);
    expect(provider.getCheckout).not.toHaveBeenCalled();
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(0);

    const runner = installFakeRunner();
    await scheduleBillingAnniversary();
    expect(runner.recurring.has("billing:anniversary-reset")).toBe(true);
    expect(runner.recurring.has("billing:actions-payments")).toBe(true);
    await runner.tick("billing:actions-payments");
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(
      actionDepositUnits(500),
    );
    expect(provider.getCheckout).toHaveBeenCalledExactlyOnceWith(f.namespace, f.checkoutId);
    expect(provider.hostingSync).not.toHaveBeenCalled();
    const checked = await repos.actionBilling.purchase(f.actor.orgId, f.id);
    expect(
      (await deliver(f.namespace, { checkoutId: f.checkoutId }, "payment.succeeded", event.id))
        .result.status,
    ).toBe(200);
    await runner.tick("billing:actions-payments");
    expect(provider.getCheckout).toHaveBeenCalledOnce();
    expect((await repos.actionBilling.purchase(f.actor.orgId, f.id))!.nextCheckAt).toEqual(
      checked!.nextCheckAt,
    );
  });

  it("recovers an accepted checkout with a lost response and applies the receipt without customer return", async () => {
    const f = await order({ saveCheckout: false });
    provider.createCheckout.mockImplementation(async (request: OblienCheckout) => {
      expect(request).toEqual(f.request);
      return {
        success: true,
        checkoutId: f.checkoutId,
        url: "https://checkout.stripe.com/test-secret",
      };
    });
    // The event can arrive before Openship has saved the returned checkout ID.
    expect(
      (
        await deliver(f.namespace, {
          kind: "topup",
          checkoutId: f.checkoutId,
          metadata: { orderId: f.id },
        })
      ).result.status,
    ).toBe(200);
    expect(await runActionsPaymentReconcile()).toEqual({ scanned: 1, checked: 1, errors: 0 });
    expect(provider.createCheckout).toHaveBeenCalledOnce();
    expect(await repos.actionBilling.purchase(f.actor.orgId, f.id)).toMatchObject({
      checkoutId: f.checkoutId,
      fundedUnits: actionDepositUnits(500),
    });
    expect(await runActionsPaymentReconcile()).toEqual({ scanned: 0, checked: 0, errors: 0 });
  });

  it("recovers delayed fulfillment and refunds when events are missing or delivered out of order", async () => {
    const f = await order();
    Object.assign(f.receipt.checkout, { fulfilled: false, fulfillmentStatus: "pending" });
    await runActionsPaymentReconcile();
    expect(await repos.actionBilling.purchase(f.actor.orgId, f.id)).toMatchObject({
      status: "processing",
      fundedUnits: 0,
    });
    Object.assign(f.receipt.checkout, { fulfilled: true, fulfillmentStatus: "completed" });
    await db
      .update(schema.actionCreditPurchase)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(schema.actionCreditPurchase.id, f.id));
    await runActionsPaymentReconcile();
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(
      actionDepositUnits(500),
    );
    Object.assign(f.receipt.checkout, {
      fulfillmentStatus: "partially_refunded",
      namespaceCreditsGranted: 125,
    });
    await deliver(f.namespace, { checkoutId: f.checkoutId }, "entitlement.changed");
    await runActionsPaymentReconcile();
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(
      actionDepositUnits(125),
    );
    await deliver(f.namespace, { checkoutId: f.checkoutId, namespaceCredits: 500 });
    await runActionsPaymentReconcile();
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(
      actionDepositUnits(125),
    );
  });

  it("saves retry deadlines while continuing other tenants when the provider is unavailable", async () => {
    const failed = await order(),
      healthy = await order();
    provider.receipts.delete(failed.checkoutId);
    expect(await runActionsPaymentReconcile()).toEqual({ scanned: 2, checked: 1, errors: 1 });
    expect(await repos.actionBilling.purchase(failed.actor.orgId, failed.id)).toMatchObject({
      fundedUnits: 0,
      checkAttempts: 1,
      checkedAt: null,
    });
    expect((await repos.actionBilling.budget(healthy.actor.orgId))!.fundedUnits).toBe(
      actionDepositUnits(500),
    );
    expect(await runActionsPaymentReconcile()).toEqual({ scanned: 0, checked: 0, errors: 0 });
    expect(provider.getCheckout).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable error until the signed event's check has been durably queued", async () => {
    const f = await order();
    const eventId = generateId("evt");
    vi.spyOn(repos.actionBilling, "queuePurchaseChecks").mockRejectedValueOnce(
      new Error("Database unavailable"),
    );
    expect(
      (await deliver(f.namespace, { checkoutId: f.checkoutId }, "payment.succeeded", eventId))
        .result.status,
    ).toBe(503);
    expect(
      await db
        .select()
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, eventId)),
    ).toEqual([]);
    expect(
      (await deliver(f.namespace, { checkoutId: f.checkoutId }, "payment.succeeded", eventId))
        .result.status,
    ).toBe(200);
    await runActionsPaymentReconcile();
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(
      actionDepositUnits(500),
    );
  });

  it("rejects invalid signatures and ambiguous ownership and ignores another tenant's checkout", async () => {
    const f = await order(),
      other = await order();
    await repos.actionBilling.reconcilePurchase(f.actor.orgId, f.id, f.checkoutId, 0, "open", 300);
    await repos.actionBilling.reconcilePurchase(
      other.actor.orgId,
      other.id,
      other.checkoutId,
      0,
      "open",
      300,
    );
    expect(
      (
        await deliver(
          f.namespace,
          { checkoutId: f.checkoutId },
          "payment.succeeded",
          generateId("evt"),
          false,
        )
      ).result.status,
    ).toBe(401);
    expect(
      (await deliver(other.namespace, { checkoutId: f.checkoutId, metadata: { orderId: f.id } }))
        .result.status,
    ).toBe(200);
    expect(await runActionsPaymentReconcile()).toEqual({ scanned: 0, checked: 0, errors: 0 });
    await db
      .update(schema.organization)
      .set({ oblienNamespace: f.namespace })
      .where(eq(schema.organization.id, other.actor.orgId));
    const event = await deliver(f.namespace, { checkoutId: f.checkoutId });
    expect(event.result.status).toBe(503);
    expect(
      await db
        .select()
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, event.id)),
    ).toEqual([]);
    expect(provider.getCheckout).not.toHaveBeenCalled();
    expect(provider.hostingSync).not.toHaveBeenCalled();
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(0);
  });

  it("does not start Cloud payment recovery or register billing timers on self-hosted instances", async () => {
    await order();
    provider.cloud = false;
    const runner = installFakeRunner();
    await scheduleBillingAnniversary();
    expect(runner.recurring.size).toBe(0);
    expect(await runActionsPaymentReconcile()).toEqual({ scanned: 0, checked: 0, errors: 0 });
    expect(provider.getCheckout).not.toHaveBeenCalled();
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });
});
