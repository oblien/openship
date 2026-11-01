import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRepositories,
  eq,
  schema,
  type DatabaseConnection,
} from "../factory";
import { generateId, actionDepositUnits } from "@repo/core";

let connection: DatabaseConnection;
let repos: ReturnType<typeof createRepositories>;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repos = createRepositories(connection.db, {
    encrypt: (value) => value,
    decrypt: (value) => value,
  });
}, 60_000);
afterAll(async () => {
  await connection?.close();
});

async function fixture() {
  const org = generateId("org");
  const namespace = `actions-${org.toLowerCase()}`;
  await connection.db.insert(schema.organization).values({ id: org, name: "Actions" });
  const purchase = await repos.actionBilling.createPurchase(
    {
      id: generateId("purchase"),
      organizationId: org,
      idempotencyKey: "deposit-one",
      priceCents: 500,
      request: { namespace, marker: "original" },
    },
    namespace,
  );
  await repos.actionBilling.recordCheckout(org, purchase.id, purchase.id, "encrypted-url");
  const fund = (units = actionDepositUnits(500), status = "completed") =>
    repos.actionBilling.reconcilePurchase(org, purchase.id, purchase.id, units, status, 86_400);
  return { org, namespace, purchase, fund };
}

describe("isolated Actions deposit records", () => {
  it("commits a payment event with its queued check, rolls both back on failure, and deduplicates delivery", async () => {
    const f = await fixture();
    await f.fund();
    const before = await repos.actionBilling.purchase(f.org, f.purchase.id);
    const event = {
      eventId: generateId("evt"),
      eventType: "payment.succeeded",
      purchaseId: f.purchase.id,
      checkoutId: "wrong-checkout",
    };
    await expect(repos.actionBilling.queuePurchaseChecks(f.org, event)).rejects.toThrow(
      "does not match",
    );
    expect(
      await connection.db
        .select()
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, event.eventId)),
    ).toHaveLength(0);
    expect((await repos.actionBilling.purchase(f.org, f.purchase.id))!.nextCheckAt).toEqual(
      before!.nextCheckAt,
    );

    event.checkoutId = f.purchase.id;
    expect(await repos.actionBilling.queuePurchaseChecks(f.org, event)).toBe(true);
    const checks = await Promise.all([
      repos.actionBilling.beginPurchaseCheck(f.org, f.purchase.id),
      repos.actionBilling.beginPurchaseCheck(f.org, f.purchase.id),
    ]);
    expect(checks.filter(Boolean)).toHaveLength(1);
    const claimed = checks.find(Boolean)!;
    expect(await repos.actionBilling.queuePurchaseChecks(f.org, event)).toBe(false);
    expect((await repos.actionBilling.purchase(f.org, f.purchase.id))!.nextCheckAt).toEqual(
      claimed.nextCheckAt,
    );
    expect(
      await connection.db
        .select()
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, event.eventId)),
    ).toMatchObject([{ processedAt: expect.any(Date) }]);
  });

  it("scopes generic and identified payment checks to the owning organization without granting funds", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.fund();
    await other.fund();
    const otherBefore = await repos.actionBilling.purchase(other.org, other.purchase.id);
    expect(
      await repos.actionBilling.queuePurchaseChecks(f.org, {
        eventId: generateId("evt"),
        eventType: "payment.succeeded",
        checkoutId: other.purchase.id,
      }),
    ).toBe(false);
    expect(
      await repos.actionBilling.queuePurchaseChecks(f.org, {
        eventId: generateId("evt"),
        eventType: "entitlement.changed",
      }),
    ).toBe(true);
    expect((await repos.actionBilling.duePurchases(100)).some((p) => p.id === f.purchase.id)).toBe(
      true,
    );
    expect((await repos.actionBilling.purchase(other.org, other.purchase.id))!.nextCheckAt).toEqual(
      otherBefore!.nextCheckAt,
    );
    expect(await repos.actionBilling.beginPurchaseCheck(other.org, f.purchase.id)).toBeUndefined();
    expect((await repos.actionBilling.budget(f.org))!.fundedUnits).toBe(actionDepositUnits(500));
    expect((await repos.actionBilling.budget(other.org))!.fundedUnits).toBe(
      actionDepositUnits(500),
    );
  });

  it("preserves the exact payment request on retries and never treats opening checkout as funding", async () => {
    const f = await fixture();
    const retry = await repos.actionBilling.createPurchase(
      {
        id: generateId("purchase"),
        organizationId: f.org,
        idempotencyKey: "deposit-one",
        priceCents: 500,
        request: { marker: "new attempt" },
      },
      f.namespace,
    );
    expect(retry.id).toBe(f.purchase.id);
    expect(retry.request.marker).toBe("original");
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(0);
    await expect(
      repos.actionBilling.createPurchase(
        {
          id: generateId("purchase"),
          organizationId: f.org,
          idempotencyKey: "deposit-one",
          priceCents: 2000,
          request: {},
        },
        f.namespace,
      ),
    ).rejects.toMatchObject({ code: "ACTIONS_CHECKOUT_CONFLICT" });
    expect(await repos.actionBilling.purchase("foreign-org", f.purchase.id)).toBeUndefined();
  });

  it("applies duplicate payment and refund observations once without erasing later purchases", async () => {
    const f = await fixture();
    await Promise.all([f.fund(), f.fund()]);
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(500));
    const second = await repos.actionBilling.createPurchase(
      {
        id: generateId("purchase"),
        organizationId: f.org,
        idempotencyKey: "second",
        priceCents: 2000,
        request: {},
      },
      f.namespace,
    );
    await repos.actionBilling.recordCheckout(f.org, second.id, second.id, "encrypted");
    await repos.actionBilling.reconcilePurchase(
      f.org,
      second.id,
      second.id,
      actionDepositUnits(2000),
      "completed",
      86_400,
    );
    await f.fund(actionDepositUnits(250), "partially_refunded");
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(2250));
    await f.fund(0, "refunded");
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(2000));
    await expect(
      repos.actionBilling.reconcilePurchase(
        f.org,
        second.id,
        f.purchase.id,
        1,
        "completed",
        86_400,
      ),
    ).rejects.toThrow("does not match");
  });

  it("keeps runner readiness separate from financial receipts and other organizations", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.fund();
    expect((await repos.actionBilling.budget(f.org))!.runnerVersion).toBe(0);
    await repos.actionBilling.markRunnersReady(f.org, 2);
    await f.fund(0, "refunded");
    expect(await repos.actionBilling.budget(f.org)).toMatchObject({
      runnerVersion: 2,
      fundedUnits: 0,
    });
    expect(await repos.actionBilling.budget(other.org)).toMatchObject({
      runnerVersion: 0,
      fundedUnits: 0,
    });
    await expect(repos.actionBilling.markRunnersReady("missing", 2)).rejects.toThrow("not found");
  });
});
