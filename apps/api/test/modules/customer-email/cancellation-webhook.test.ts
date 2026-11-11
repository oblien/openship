import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";

const provider = vi.hoisted(() => ({
  secret: "customer-cancellation-test-secret",
  refresh: vi.fn(),
  management: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: { ...actual.env, CLOUD_MODE: true, OBLIEN_WEBHOOK_SECRET: provider.secret },
  };
});
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/billing/billing-oblien-quota")
  >()),
  withCloudBillingLock: async (
    _org: string,
    run: (refresh: typeof provider.refresh) => Promise<void>,
  ) => run(provider.refresh),
}));
vi.mock("@repo/platform/engine/modules/billing/management.service", () => ({
  syncManagementBilling: provider.management,
}));

import { db, repos, schema, seedOwner } from "../jobs/_harness";
import { closeDb, eq } from "@repo/db";
import type {
  OblienSubscription,
  OblienEntitlement,
} from "@repo/platform/engine/lib/oblien-billing-api";
import { handleOblienWebhook } from "@repo/platform/engine/modules/billing/oblien-webhook.service";
import { CustomerEmailService } from "@repo/platform/engine/modules/customer-email/service";

const current: NonNullable<OblienSubscription> = {
  tierId: "capacity",
  status: "active",
  billingInterval: "monthly",
  periodStart: "2026-11-01T00:00:00Z",
  periodEnd: "2099-12-01T00:00:00Z",
  cancelAtPeriodEnd: true,
  canceledAt: "2026-11-09T00:00:00Z",
};
const entitlement = (namespace: string): OblienEntitlement => ({
  success: true,
  namespace,
  tierId: "pro",
  status: "active",
  periodStart: current.periodStart,
  periodEnd: current.periodEnd,
  quota: { limit: 100, used: 0, balance: 100 },
});
const rows = () => db.select().from(schema.cloudCustomerEmail);
beforeEach(async () => {
  await db.delete(schema.cloudCustomerEmail);
  provider.refresh.mockReset();
  provider.management.mockReset();
});
afterAll(() => closeDb());

async function fixture(scope: "hosting" | "management" = "hosting") {
  const owner = await seedOwner();
  const namespace = `ns-${randomUUID()}`;
  if (scope === "hosting") {
    await db
      .update(schema.organization)
      .set({ oblienNamespace: namespace })
      .where(eq(schema.organization.id, owner.orgId));
  } else {
    await repos.managementBilling.ensure(owner.orgId, namespace);
  }
  provider.refresh.mockResolvedValue({
    subscription: current,
    entitlement: entitlement(namespace),
    tier: "pro",
  });
  provider.management.mockResolvedValue({ subscription: current });
  return { ...owner, namespace };
}
async function deliver(
  namespace: string,
  options: {
    id?: string;
    event?: string;
    signed?: boolean;
    data?: Record<string, unknown>;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const body = JSON.stringify({
    id,
    event: options.event ?? "subscription.updated",
    data: { namespace, ...options.data },
  });
  const signature = createHmac("sha256", options.signed === false ? "wrong" : provider.secret)
    .update(body)
    .digest("hex");
  return handleOblienWebhook(body, signature, id);
}

it.each(["hosting", "management"] as const)(
  "takes a signed %s cancellation through persisted ownership, checkpoint, queue and delivery",
  async (scope) => {
    const f = await fixture(scope);
    const id = randomUUID();
    expect(await deliver(f.namespace, { id })).toMatchObject({ status: 200 });
    expect(await deliver(f.namespace, { id })).toMatchObject({ status: 200 });
    expect(await deliver(f.namespace, { event: "subscription.canceled" })).toMatchObject({
      status: 200,
    });
    expect(await rows()).toMatchObject([
      {
        kind: "cancellation",
        userId: f.userId,
        organizationId: f.orgId,
        cancellation: { namespace: f.namespace, scope },
      },
    ]);
    const send = vi.fn().mockResolvedValue(true);
    const mailer = new CustomerEmailService({
      enabled: () => true,
      repo: repos.cloudCustomerEmail,
      send,
      dashboardUrl: "https://app.openship.io",
      now: () => new Date(Date.now() + 60_000),
      readSubscription: async (namespace) => {
        expect(namespace).toBe(f.namespace);
        return current;
      },
    });
    expect(await mailer.flush()).toEqual({ sent: 1, failed: 0, canceled: 0 });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: (await repos.user.findById(f.userId))!.email,
        replyTo: "support@openship.io",
        customerSender: "support",
      }),
    );
  },
);

it("does not queue unsigned, foreign-namespace or stale cancellation notifications", async () => {
  const f = await fixture();
  expect(await deliver(f.namespace, { signed: false })).toMatchObject({ status: 401 });
  expect(await deliver("ns-not-owned")).toMatchObject({ status: 200 });
  expect(provider.refresh).not.toHaveBeenCalled();
  provider.refresh.mockResolvedValue({
    subscription: { ...current, cancelAtPeriodEnd: false, canceledAt: null },
    entitlement: entitlement(f.namespace),
    tier: "pro",
  });
  expect(
    await deliver(f.namespace, {
      event: "subscription.canceled",
      data: { cancelAtPeriodEnd: true },
    }),
  ).toMatchObject({ status: 200 });
  expect(await rows()).toEqual([]);
});

it("leaves failed provider synchronization retryable instead of sending or acknowledging a cancellation", async () => {
  const f = await fixture();
  const id = randomUUID();
  provider.refresh.mockRejectedValueOnce(new Error("provider unavailable"));
  expect(await deliver(f.namespace, { id })).toMatchObject({ status: 503 });
  expect(await rows()).toEqual([]);
  expect(await deliver(f.namespace, { id })).toMatchObject({ status: 200 });
  expect(await rows()).toHaveLength(1);
});

it("rejects a signed event whose organization metadata disagrees with persisted ownership", async () => {
  const f = await fixture();
  expect(
    await deliver(f.namespace, { data: { metadata: { openship_organization: "org-foreign" } } }),
  ).toMatchObject({ status: 503 });
  expect(await rows()).toEqual([]);
});
