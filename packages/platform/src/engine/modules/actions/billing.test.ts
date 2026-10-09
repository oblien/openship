import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  eq,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { actionDepositUnits, generateId, withKeyedMutex } from "@repo/core";
import type { OblienBillingApi, OblienCheckout } from "../../lib/oblien-billing-api";
import { ActionCredits, actionBillingNamespace } from "./billing";

let connection: DatabaseConnection;
let repo: ReturnType<typeof createRepositories>["actionBilling"];
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createRepositories(connection.db, {
    encrypt: (value) => value,
    decrypt: (value) => value,
  }).actionBilling;
}, 60_000);
afterAll(async () => {
  await connection?.close();
});

type Receipt = Awaited<ReturnType<OblienBillingApi["getCheckout"]>>;
async function makeDue(id: string) {
  await connection.db
    .update(schema.actionCreditPurchase)
    .set({ nextCheckAt: new Date(0) })
    .where(eq(schema.actionCreditPurchase.id, id));
}
async function fixture() {
  const org = generateId("org");
  await connection.db.insert(schema.organization).values({ id: org, name: "Actions billing" });
  const accepted = new Map<string, { request: OblienCheckout; receipt: Receipt }>();
  const createCheckout = vi.fn(async (request: OblienCheckout) => {
    let entry = accepted.get(request.idempotencyKey);
    if (!entry) {
      const id = generateId("checkout");
      entry = {
        request: structuredClone(request),
        receipt: {
          success: true,
          namespace: request.namespace,
          checkout: {
            id,
            kind: "topup",
            status: "open",
            paymentStatus: "unpaid",
            fulfilled: false,
            fulfillmentStatus: "pending",
            namespaceCreditsGranted: 0,
          },
        } as Receipt,
      };
      accepted.set(request.idempotencyKey, entry);
    } else expect(request).toEqual(entry.request);
    return {
      success: true as const,
      checkoutId: entry.receipt.checkout.id,
      url: `https://checkout.stripe.com/${entry.receipt.checkout.id}`,
    };
  });
  const getCheckout = vi.fn(async (namespace: string, id: string) => {
    const entry = [...accepted.values()].find((value) => value.receipt.checkout.id === id);
    if (!entry) throw new Error("Provider checkout not found");
    expect(namespace).toBe(entry.request.namespace);
    return structuredClone(entry.receipt);
  });
  const ports = {
    repo,
    provider: { createCheckout, getCheckout },
    lock: <T>(id: string, operation: () => Promise<T>) =>
      withKeyedMutex(`action-test:${id}`, operation),
    encrypt: (value: string) => `sealed:${value}`,
    decrypt: (value: string) => value.slice(7),
    dashboardUrl: "https://app.example.test",
  };
  const service = new ActionCredits(ports);
  const receipt = () => [...accepted.values()][0]!.receipt;
  const paid = (net = 500) =>
    Object.assign(receipt().checkout, {
      status: "complete",
      paymentStatus: "paid",
      fulfilled: true,
      fulfillmentStatus: net === 500 ? "completed" : net > 0 ? "partially_refunded" : "refunded",
      namespaceCreditsGranted: net,
    });
  return { org, accepted, createCheckout, getCheckout, service, ports, receipt, paid };
}

describe("Actions prepaid checkout recovery", () => {
  it("recovers a lost checkout response after restart without a browser visit or a second payment", async () => {
    const f = await fixture();
    const create = f.createCheckout.getMockImplementation()!;
    f.createCheckout.mockImplementationOnce(async (request) => {
      await create(request);
      throw new Error("Connection lost after acceptance");
    });
    await expect(f.service.checkout(f.org, 500, "lost-response")).rejects.toThrow(
      "Connection lost",
    );
    const [purchase] = await repo.purchases(f.org);
    // A GET remains a read when checkout creation has an uncertain result.
    expect((await f.service.inspect(f.org, purchase!.id)).checkoutId).toBeNull();
    expect(f.createCheckout).toHaveBeenCalledTimes(1);
    expect(f.getCheckout).not.toHaveBeenCalled();
    f.paid();
    const restarted = new ActionCredits({
      ...f.ports,
      dashboardUrl: "https://changed.example.test",
    });
    expect(
      await Promise.all([
        restarted.recoverDuePurchase(f.org, purchase!.id),
        restarted.recoverDuePurchase(f.org, purchase!.id),
      ]),
    ).toEqual([true, false]);
    expect(f.accepted.size).toBe(1);
    expect(f.createCheckout.mock.calls[1]?.[0]).toEqual(f.createCheckout.mock.calls[0]?.[0]);
    expect(f.getCheckout).toHaveBeenCalledOnce();
    expect(await repo.budget(f.org)).toMatchObject({ fundedUnits: actionDepositUnits(500) });
    expect(await repo.purchase(f.org, purchase!.id)).toMatchObject({
      status: "completed",
      checkAttempts: 0,
    });
  });

  it("persists bounded retries before provider I/O and survives a claimed check's process disappearing", async () => {
    const f = await fixture();
    const payment = await f.service.checkout(f.org, 500, "retry-payment");
    // A process can die after this durable claim but before sending a request.
    const claim = await repo.beginPurchaseCheck(f.org, payment.purchaseId);
    expect(claim!.checkAttempts).toBe(1);
    expect(claim!.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 25_000);
    const restarted = new ActionCredits(f.ports);
    expect(await restarted.recoverDuePurchase(f.org, payment.purchaseId)).toBe(false);
    expect(f.getCheckout).not.toHaveBeenCalled();
    await makeDue(payment.purchaseId);
    f.getCheckout.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(restarted.recoverDuePurchase(f.org, payment.purchaseId)).rejects.toThrow(
      "Provider unavailable",
    );
    const failed = await repo.purchase(f.org, payment.purchaseId);
    expect(failed).toMatchObject({ checkAttempts: 2, checkedAt: null, fundedUnits: 0 });
    expect(failed!.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 55_000);
    expect(await restarted.recoverDuePurchase(f.org, payment.purchaseId)).toBe(false);
    // Even a persistently failing provider cannot overflow the counter/deadline.
    await connection.db
      .update(schema.actionCreditPurchase)
      .set({ checkAttempts: 10 })
      .where(eq(schema.actionCreditPurchase.id, payment.purchaseId));
    await makeDue(payment.purchaseId);
    const last = await repo.beginPurchaseCheck(f.org, payment.purchaseId);
    expect(last!.checkAttempts).toBe(10);
    expect(last!.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 295_000);
    expect(last!.nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
    f.paid();
    await makeDue(payment.purchaseId);
    expect(await restarted.recoverDuePurchase(f.org, payment.purchaseId)).toBe(true);
    expect(await repo.purchase(f.org, payment.purchaseId)).toMatchObject({
      checkAttempts: 0,
      fundedUnits: actionDepositUnits(500),
    });
  });

  it("does not lose a refund event queued while an older receipt is in flight", async () => {
    const f = await fixture();
    const payment = await f.service.checkout(f.org, 500, "refund-race");
    f.paid();
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const read = f.getCheckout.getMockImplementation()!;
    f.getCheckout.mockImplementationOnce(async (namespace, id) => {
      const snapshot = await read(namespace, id);
      started();
      await barrier;
      return snapshot;
    });
    const older = f.service.inspect(f.org, payment.purchaseId);
    await entered;
    f.paid(0);
    const event = {
      eventId: generateId("evt"),
      eventType: "entitlement.changed",
      purchaseId: payment.purchaseId,
    };
    const queued = f.service.queuePaymentCheck(f.org, event);
    release();
    await Promise.all([older, queued]);
    expect(await f.service.recoverDuePurchase(f.org, payment.purchaseId)).toBe(true);
    expect((await repo.budget(f.org))!.fundedUnits).toBe(0);
    const verified = await repo.purchase(f.org, payment.purchaseId);
    expect(await f.service.queuePaymentCheck(f.org, event)).toBe(false);
    expect((await repo.purchase(f.org, payment.purchaseId))!.nextCheckAt).toEqual(
      verified!.nextCheckAt,
    );
  });

  it("checks delayed fulfillment promptly and retires expired checkouts until a new signed event", async () => {
    const f = await fixture();
    const payment = await f.service.checkout(f.org, 500, "delayed-payment");
    Object.assign(f.receipt().checkout, { status: "complete", paymentStatus: "paid" });
    await f.service.recoverDuePurchase(f.org, payment.purchaseId);
    const processing = await repo.purchase(f.org, payment.purchaseId);
    expect(processing).toMatchObject({ status: "processing", fundedUnits: 0 });
    expect(processing!.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 55_000);
    Object.assign(f.receipt().checkout, { status: "expired", paymentStatus: "unpaid" });
    await makeDue(payment.purchaseId);
    await f.service.recoverDuePurchase(f.org, payment.purchaseId);
    expect(await repo.purchase(f.org, payment.purchaseId)).toMatchObject({
      status: "expired",
      nextCheckAt: null,
    });
    expect(await f.service.recoverDuePurchase(f.org, payment.purchaseId)).toBe(false);
    f.paid();
    await f.service.queuePaymentCheck(f.org, {
      eventId: generateId("evt"),
      eventType: "payment.succeeded",
      checkoutId: f.receipt().checkout.id,
    });
    await f.service.recoverDuePurchase(f.org, payment.purchaseId);
    expect((await repo.budget(f.org))!.fundedUnits).toBe(actionDepositUnits(500));
  });

  it("reuses the exact persisted offer after the provider accepted checkout but its response was lost", async () => {
    const f = await fixture();
    const create = f.createCheckout.getMockImplementation()!;
    f.createCheckout.mockImplementationOnce(async (request) => {
      await create(request);
      throw new Error("Connection closed after acceptance");
    });
    await expect(f.service.checkout(f.org, 500, "payment-attempt")).rejects.toThrow(
      "Connection closed",
    );
    const [pending] = await repo.purchases(f.org);
    expect(pending?.checkoutId).toBeNull();
    expect((await repo.budget(f.org))?.fundedUnits).toBe(0);
    // Restarting the service, even with a new configured return URL, must not
    // change the provider request associated with this payment attempt.
    const restarted = new ActionCredits({ ...f.ports, dashboardUrl: "https://new.example.test" });
    const result = await restarted.checkout(f.org, 500, "payment-attempt");
    expect(result.purchaseId).toBe(pending!.id);
    expect(f.accepted.size).toBe(1);
    expect(f.createCheckout.mock.calls[1]?.[0]).toEqual(f.createCheckout.mock.calls[0]?.[0]);
    expect(result.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect((await repo.purchase(f.org, result.purchaseId))?.checkoutUrlEnc).toBe(
      `sealed:${result.checkoutUrl}`,
    );
  });

  it("funds only verified fulfillment, once, and applies partial refunds without erasing another deposit", async () => {
    const f = await fixture();
    const payment = await f.service.checkout(f.org, 500, "payment-attempt");
    Object.assign(f.receipt().checkout, {
      status: "complete",
      paymentStatus: "paid",
      fulfillmentStatus: "pending",
    });
    expect(await f.service.inspect(f.org, payment.purchaseId)).toMatchObject({
      status: "processing",
      fundedUnits: 0,
    });
    expect(await f.service.resume(f.org, payment.purchaseId)).toEqual({
      purchaseId: payment.purchaseId,
      checkoutUrl: null,
    });
    f.paid();
    await Promise.all([
      f.service.inspect(f.org, payment.purchaseId),
      f.service.inspect(f.org, payment.purchaseId),
    ]);
    expect((await repo.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(500));
    const second = await f.service.checkout(f.org, 2000, "second-payment");
    const receipt = [...f.accepted.values()][1]!.receipt;
    Object.assign(receipt.checkout, {
      status: "complete",
      paymentStatus: "paid",
      fulfilled: true,
      fulfillmentStatus: "completed",
      namespaceCreditsGranted: 2000,
    });
    await f.service.inspect(f.org, second.purchaseId);
    f.paid(125);
    await f.service.inspect(f.org, payment.purchaseId);
    expect((await repo.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(2125));
    f.paid(0);
    await f.service.inspect(f.org, payment.purchaseId);
    expect((await repo.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(2000));
    expect(await f.service.resume(f.org, payment.purchaseId)).toMatchObject({ checkoutUrl: null });
  });

  it("serializes a slow older receipt read before a later refund observation", async () => {
    const f = await fixture();
    const payment = await f.service.checkout(f.org, 500, "payment-attempt");
    f.paid();
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const read = f.getCheckout.getMockImplementation()!;
    f.getCheckout.mockImplementationOnce(async (namespace, id) => {
      const snapshot = await read(namespace, id);
      started();
      await barrier;
      return snapshot;
    });
    const older = f.service.inspect(f.org, payment.purchaseId);
    await entered;
    f.paid(0);
    const refund = f.service.inspect(f.org, payment.purchaseId);
    expect(f.getCheckout).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([older, refund]);
    expect((await repo.budget(f.org))?.fundedUnits).toBe(0);
  });

  it("rejects a mismatched namespace, checkout, kind or amount and another organization's payment", async () => {
    const f = await fixture();
    const payment = await f.service.checkout(f.org, 500, "payment-attempt");
    f.paid();
    const original = structuredClone(f.receipt());
    for (const changed of [
      { ...original, namespace: "another-org" },
      { ...original, checkout: { ...original.checkout, id: "wrong-id" } },
      { ...original, checkout: { ...original.checkout, kind: "subscription" as const } },
      { ...original, checkout: { ...original.checkout, namespaceCreditsGranted: 501 } },
    ]) {
      f.getCheckout.mockResolvedValueOnce(changed);
      await expect(f.service.inspect(f.org, payment.purchaseId)).rejects.toMatchObject({
        statusCode: 502,
      });
      expect((await repo.budget(f.org))?.fundedUnits).toBe(0);
    }
    const other = await fixture();
    await expect(f.service.inspect(other.org, payment.purchaseId)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(actionBillingNamespace(f.org)).not.toBe(actionBillingNamespace(other.org));
  });

  it("rejects unapproved deposit amounts and keeps checked, open payments in the unfinished limit", async () => {
    const f = await fixture();
    await expect(f.service.checkout(f.org, 1, "payment-attempt")).rejects.toMatchObject({
      code: "ACTIONS_DEPOSIT_INVALID",
    });
    expect(f.createCheckout).not.toHaveBeenCalled();
    for (let i = 0; i < 20; i++) {
      const pending = await f.service.checkout(f.org, 500, `payment-${i}`);
      await f.service.inspect(f.org, pending.purchaseId);
    }
    await expect(f.service.checkout(f.org, 500, "payment-overflow")).rejects.toMatchObject({
      code: "ACTIONS_CHECKOUT_LIMIT",
    });
    expect(await f.service.checkout(f.org, 500, "payment-0")).toMatchObject({
      purchaseId: expect.any(String),
    });
  });
});
