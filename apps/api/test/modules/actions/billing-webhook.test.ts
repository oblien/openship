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
  ensureNamespace: vi.fn(),
  getNamespace: vi.fn(),
  updateNamespace: vi.fn(),
  getDefaults: vi.fn(),
  getPolicy: vi.fn(),
  getEntitlement: vi.fn(),
  getSubscription: vi.fn(),
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
  getOblienClient: () => ({
    namespaces: {
      ensure: provider.ensureNamespace,
      get: provider.getNamespace,
      update: provider.updateNamespace,
    },
  }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/billing/billing-oblien-quota")
  >()),
  withCloudBillingLock: provider.hostingSync,
}));

import { db, repos, schema, seedOwner, installFakeRunner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { actionDepositUnits, generateId, PRICING } from "@repo/core";
import { actionBillingNamespace } from "@repo/platform/engine/modules/actions/billing";
import { runActionsPaymentReconcile } from "@repo/platform/engine/modules/actions/billing-application";
import { handleOblienWebhook } from "@repo/platform/engine/modules/billing/oblien-webhook.service";
import { scheduleBillingAnniversary } from "@repo/platform/engine/modules/billing/billing-anniversary.cron";
import { ensureActionsBillingNamespace } from "@repo/platform/engine/modules/actions/billing-namespace";

const prepaidPolicy = {
  success: true,
  service: "workspace_vm",
  quotaLimit: 0,
  overdraft: 0,
  suspendThreshold: 0,
  onOverdraftAction: "stop_workspaces",
};

beforeEach(async () => {
  provider.cloud = true;
  provider.receipts.clear();
  provider.hostingSync.mockReset();
  provider.getNamespace
    .mockReset()
    .mockImplementation(async (slug) => ({ success: true, data: { id: slug, slug } }));
  provider.updateNamespace
    .mockReset()
    .mockImplementation(async (id, { resource_limits }) => ({
      success: true,
      data: { id, slug: id, resource_limits, effective_resource_limits: resource_limits },
    }));
  provider.ensureNamespace.mockReset().mockImplementation(async ({ slug }) => ({ data: { slug } }));
  provider.getDefaults.mockReset().mockResolvedValue({ ...prepaidPolicy, autoApply: true });
  provider.getPolicy
    .mockReset()
    .mockImplementation(async (namespace) => ({ ...prepaidPolicy, namespace }));
  provider.getEntitlement.mockReset().mockImplementation(async (namespace) => ({
    success: true,
    namespace,
    tierId: "free",
    status: "credit_exhausted",
    periodStart: null,
    periodEnd: null,
    billingMode: "metered",
    capacity: null,
    quota: { limit: 0, used: 0, balance: 0 },
  }));
  provider.getSubscription.mockReset().mockImplementation(async (namespace) => ({
    success: true,
    namespace,
    subscription: null,
  }));
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
  it("activates all sizes once after signed funding and recovers a failed capacity update", async () => {
    const f = await order();
    provider.updateNamespace.mockRejectedValueOnce(new Error("Provider temporarily unavailable"));
    expect(await runActionsPaymentReconcile()).toMatchObject({ checked: 0, errors: 1 });
    expect(await repos.actions.listRunners(f.actor.orgId)).toEqual([]);
    expect(await repos.actionBilling.budget(f.actor.orgId)).toMatchObject({
      fundedUnits: actionDepositUnits(500),
      runnerVersion: 0,
      runnerSetupFailed: true,
    });
    await deliver(f.namespace, { checkoutId: f.checkoutId });
    expect(await runActionsPaymentReconcile()).toMatchObject({ checked: 1, errors: 0 });
    const runners = await repos.actions.listRunners(f.actor.orgId);
    expect(runners).toHaveLength(3);
    expect(new Set(runners.map((runner) => runner.cloudPoolId))).toEqual(new Set([f.namespace]));
    expect(runners.map((runner) => runner.config.cpu).sort((a, b) => a - b)).toEqual([2, 4, 8]);
    expect(
      runners.every(
        (runner) =>
          runner.enabled &&
          runner.cloudProfileId &&
          runner.config.maxParallel === PRICING.actions.maxParallel,
      ),
    ).toBe(true);
    expect((await repos.actionBilling.budget(f.actor.orgId))!.runnerVersion).toBe(
      PRICING.actions.version,
    );
    await deliver(f.namespace, { checkoutId: f.checkoutId });
    await runActionsPaymentReconcile();
    expect((await repos.actions.listRunners(f.actor.orgId)).map((runner) => runner.id)).toEqual(
      runners.map((runner) => runner.id),
    );
    expect(provider.updateNamespace).toHaveBeenCalledTimes(2);
    expect(provider.createCheckout).not.toHaveBeenCalled();
    expect(await repos.cloudWorkspace.listByOrganization(f.actor.orgId)).toEqual([]);
  });

  it("does not enable runners if the provider returns another namespace or insufficient caps", async () => {
    const f = await order();
    provider.getNamespace.mockResolvedValueOnce({
      success: true,
      data: { id: "other", slug: "other" },
    });
    expect(await runActionsPaymentReconcile()).toMatchObject({ checked: 0, errors: 1 });
    expect(provider.updateNamespace).not.toHaveBeenCalled();
    await deliver(f.namespace, { checkoutId: f.checkoutId });
    provider.updateNamespace.mockImplementationOnce(async (id, { resource_limits }) => ({
      success: true,
      data: {
        id,
        slug: id,
        resource_limits,
        effective_resource_limits: { ...resource_limits, max_total_vcpus: 0 },
      },
    }));
    expect(await runActionsPaymentReconcile()).toMatchObject({ checked: 0, errors: 1 });
    expect(await repos.actions.listRunners(f.actor.orgId)).toEqual([]);
    expect((await repos.actionBilling.budget(f.actor.orgId))!.runnerVersion).toBe(0);
  });

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
    // Payment preparation and funded runner setup both verify the same namespace.
    expect(provider.ensureNamespace).toHaveBeenCalledTimes(2);
    expect(provider.getPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      provider.createCheckout.mock.invocationCallOrder[0]!,
    );
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

describe("Actions namespace preparation before checkout", () => {
  it("creates only the persisted Actions namespace with no free compute or allowance", async () => {
    const f = await order({ saveCheckout: false });
    await ensureActionsBillingNamespace(f.actor.orgId);
    expect(provider.ensureNamespace).toHaveBeenCalledExactlyOnceWith({
      name: "Openship Actions",
      slug: f.namespace,
      resource_limits: {
        max_workspaces: 0,
        max_vcpus: 0,
        max_ram_mb: 0,
        max_disk_gb: 0,
        max_total_vcpus: 0,
        max_total_ram_mb: 0,
        max_total_disk_gb: 0,
      },
    });
    expect(provider.getPolicy).toHaveBeenCalledExactlyOnceWith(f.namespace);
    expect(provider.getEntitlement).toHaveBeenCalledExactlyOnceWith(f.namespace);
    expect(provider.getSubscription).toHaveBeenCalledExactlyOnceWith(f.namespace);
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(0);
    expect(await repos.cloudWorkspace.listByOrganization(f.actor.orgId)).toEqual([]);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("reuses funded namespaces without resetting purchased allowance, usage or resource caps", async () => {
    const f = await order();
    await repos.actionBilling.reconcilePurchase(
      f.actor.orgId,
      f.id,
      f.checkoutId,
      actionDepositUnits(500),
      "completed",
      86_400,
    );
    const policy = {
      ...prepaidPolicy,
      namespace: f.namespace,
      purchasedCredits: 500,
      effectiveCeiling: 500,
      used: 57,
    };
    const limits = { max_workspaces: 1, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 40 };
    // The documented ensure contract ignores initial resource limits for an
    // existing slug. No resource/policy update endpoint is available in this fake.
    provider.ensureNamespace.mockResolvedValue({
      created: false,
      data: { slug: f.namespace, resource_limits: limits },
    });
    provider.getPolicy.mockResolvedValue(policy);
    provider.getEntitlement.mockResolvedValue({
      namespace: f.namespace,
      billingMode: "metered",
      capacity: null,
      quota: { limit: 500, used: 57, balance: 443 },
    });
    const before = await repos.actionBilling.budget(f.actor.orgId);
    await ensureActionsBillingNamespace(f.actor.orgId);
    await ensureActionsBillingNamespace(f.actor.orgId);
    expect(await repos.actionBilling.budget(f.actor.orgId)).toEqual(before);
    expect(policy).toMatchObject({ purchasedCredits: 500, used: 57 });
    expect(limits).toMatchObject({
      max_workspaces: 1,
      max_vcpus: 2,
      max_ram_mb: 4096,
      max_disk_gb: 40,
    });
    expect(provider.ensureNamespace.mock.calls[1]).toEqual(provider.ensureNamespace.mock.calls[0]);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("does not contact the provider without a matching persisted budget or outside Cloud", async () => {
    const actor = await seedOwner();
    await expect(ensureActionsBillingNamespace(actor.orgId)).rejects.toMatchObject({
      code: "ACTIONS_CHECKOUT_CONFLICT",
    });
    const f = await order();
    await db
      .update(schema.actionBudget)
      .set({ namespace: `${f.namespace}-different` })
      .where(eq(schema.actionBudget.organizationId, f.actor.orgId));
    await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toMatchObject({
      code: "ACTIONS_CHECKOUT_CONFLICT",
    });
    provider.cloud = false;
    await expect(ensureActionsBillingNamespace(actor.orgId)).rejects.toMatchObject({
      code: "ACTIONS_BILLING_CLOUD_ONLY",
    });
    expect(provider.getDefaults).not.toHaveBeenCalled();
    expect(provider.ensureNamespace).not.toHaveBeenCalled();
  });

  it.each(["organization", "server"])(
    "never adopts a namespace also bound to %s billing",
    async (kind) => {
      const f = await order();
      const other = await seedOwner();
      if (kind === "organization") {
        await db
          .update(schema.organization)
          .set({ oblienNamespace: f.namespace })
          .where(eq(schema.organization.id, other.orgId));
      } else {
        await db.insert(schema.cloudWorkspace).values({
          id: generateId("workspace"),
          organizationId: other.orgId,
          name: "Paid server",
          namespace: f.namespace,
        });
      }
      await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toThrow(
        "ambiguous billing ownership",
      );
      expect(provider.ensureNamespace).not.toHaveBeenCalled();
      expect(provider.getDefaults).not.toHaveBeenCalled();
    },
  );

  it.each([
    { autoApply: false },
    { quotaLimit: null },
    { quotaLimit: 500 },
    { overdraft: 1 },
    { suspendThreshold: 1 },
    { onOverdraftAction: "block" },
  ])("rejects unsafe onboarding defaults %j before namespace creation", async (invalid) => {
    const f = await order();
    provider.getDefaults.mockResolvedValue({ ...prepaidPolicy, autoApply: true, ...invalid });
    await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toMatchObject({
      code: "OBLIEN_DEFAULT_POLICY_REQUIRED",
    });
    expect(provider.ensureNamespace).not.toHaveBeenCalled();
  });

  it.each([
    { quotaLimit: null },
    { quotaLimit: 500 },
    { overdraft: 1 },
    { suspendThreshold: null },
    { suspendThreshold: 1 },
    { onOverdraftAction: "block" },
  ])("rejects an existing unsafe policy %j without rewriting it", async (invalid) => {
    const f = await order();
    provider.getPolicy.mockResolvedValue({ ...prepaidPolicy, namespace: f.namespace, ...invalid });
    await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toMatchObject({
      code: "ACTIONS_FUNDING_POLICY_REQUIRED",
    });
    expect((await repos.actionBilling.budget(f.actor.orgId))!.fundedUnits).toBe(0);
  });

  it.each(["monthly", "capacity", "subscription"])(
    "rejects a provider %s contract instead of repurposing it",
    async (kind) => {
      const f = await order();
      if (kind === "subscription")
        provider.getSubscription.mockResolvedValue({
          namespace: f.namespace,
          subscription: { tierId: "pro" },
        });
      else
        provider.getEntitlement.mockResolvedValue({
          namespace: f.namespace,
          billingMode: kind === "monthly" ? "monthly" : "metered",
          capacity: kind === "capacity" ? {} : null,
        });
      await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toMatchObject({
        code: "ACTIONS_FUNDING_INVALID",
      });
    },
  );

  it("retries uncertain creation with the original slug and rejects a provider identity mismatch", async () => {
    const f = await order();
    provider.ensureNamespace.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toThrow("Connection lost");
    await ensureActionsBillingNamespace(f.actor.orgId);
    expect(provider.ensureNamespace.mock.calls[1]).toEqual(provider.ensureNamespace.mock.calls[0]);
    provider.ensureNamespace.mockResolvedValueOnce({ data: { slug: "another-customer" } });
    await expect(ensureActionsBillingNamespace(f.actor.orgId)).rejects.toMatchObject({
      code: "CLOUD_NAMESPACE_MISMATCH",
    });
    expect(provider.getPolicy).toHaveBeenCalledOnce();
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });
});
