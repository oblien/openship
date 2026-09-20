import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * End-to-end dispatch test for the Oblien webhook handler with every heavy
 * dependency (db / quota wrapper / mail / audit / notifications / env) mocked,
 * so it stays self-contained (no DB, no Oblien, no network). Verifies the
 * signature gate + that each event routes to the right side effect.
 */

const SECRET = "whsec_test_oblien";

const h = vi.hoisted(() => ({
  secret: undefined as string | undefined,
  usageUpsert: vi.fn(),
  orgFindById: vi.fn(),
  auditRecord: vi.fn(),
  notificationEmit: vi.fn(),
  sendMail: vi.fn(),
  orgRows: [{ id: "org_1" }] as Array<{ id: string }>,
  existingRows: [] as Array<{ processedAt: Date | null }>,
  processed: new Map<string, Date>(),
  sync: vi.fn(),
}));

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get OBLIEN_WEBHOOK_SECRET() {
      return h.secret;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/mail", () => ({ sendMail: h.sendMail }));
vi.mock("../../lib/audit", () => ({ audit: { record: h.auditRecord } }));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: h.notificationEmit },
}));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({
  resolveOrgOwner: async () => ({ user: { email: "owner@example.com", name: "Owner" } }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  fromOblienCredits: (c: number) => c * 1000,
  withCloudBillingLock: async (_orgId: string, work: (sync: typeof h.sync) => Promise<unknown>) => work(h.sync),
}));
vi.mock("@repo/db", () => {
  const tx = {
    execute: async () => ({ rows: [{ acquired: true }] }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => h.existingRows }) }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  };
  return {
    db: {
      transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
      select: () => ({ from: (table: { kind?: string }) => ({ where: (predicate: { value: string }) => ({ limit: async () =>
        table.kind === "event" ? (h.processed.has(predicate.value) ? [{ processedAt: h.processed.get(predicate.value) }] : h.existingRows) : h.orgRows,
      }) }) }),
      insert: () => ({ values: (value: { oblienEventId: string; processedAt: Date }) => ({ onConflictDoUpdate: async () => {
        h.processed.set(value.oblienEventId, value.processedAt);
      } }) }),
    },
    schema: {
      organization: { id: {}, oblienNamespace: {} },
      oblienWebhookEvent: { kind: "event", oblienEventId: {}, processedAt: {} },
    },
    repos: {
      billingUsageSnapshot: { upsert: h.usageUpsert },
      organization: { findById: h.orgFindById },
    },
    eq: (_column: unknown, value: string) => ({ value }),
    sql: (..._a: unknown[]) => ({}),
    hashStringToInt: () => 1,
  };
});

// Import AFTER the mocks are registered.
import { oblienWebhook } from "./oblien-webhook.controller";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

interface JsonResult {
  obj: unknown;
  status: number;
}

function makeCtx(body: string, sig?: string, deliveryId?: string) {
  return {
    req: {
      header: (n: string) => (n.toLowerCase() === "x-webhook-signature" ? sig : n.toLowerCase() === "x-webhook-id" ? deliveryId : undefined),
      text: async () => body,
    },
    json: (obj: unknown, status = 200): JsonResult => ({ obj, status }),
  } as never;
}

beforeEach(() => {
  h.secret = SECRET;
  h.orgRows = [{ id: "org_1" }];
  h.existingRows = [];
  h.orgFindById.mockReset();
  h.usageUpsert.mockReset();
  h.auditRecord.mockReset();
  h.notificationEmit.mockReset();
  h.sendMail.mockReset();
  h.processed.clear();
  h.sync.mockReset().mockResolvedValue({ entitlement: { status: "credit_exhausted" } });
});

describe("oblienWebhook — signature gate", () => {
  it("503 when the secret isn't configured", async () => {
    h.secret = undefined;
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(503);
  });

  it("401 on a bad signature", async () => {
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body, "wrong")))) as unknown as JsonResult;
    expect(res.status).toBe(401);
  });

  it("401 when the signature header is missing", async () => {
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, undefined))) as unknown as JsonResult;
    expect(res.status).toBe(401);
  });

  it.each([undefined, "evt-other"])("rejects a signed body id that does not match header %s", async deliveryId => {
    const body = JSON.stringify({ id: "evt-signed", event: "payment.succeeded", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body), deliveryId))) as unknown as JsonResult;
    expect(res.status).toBe(400);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.processed.size).toBe(0);
  });
});

describe("oblienWebhook — dispatch", () => {
  it("credits.usage → upserts the snapshot with credits converted to milli (×1000)", async () => {
    const body = JSON.stringify({
      event: "credits.usage",
      timestamp: "t1",
      data: {
        namespace: "os-abc",
        balance: 5,
        credits_used: 2,
        usage: { cpu_time_minutes: 120, memory_gb_minutes: 30, disk_io_gb: 1, network_gb: 0.5 },
      },
    });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.usageUpsert).toHaveBeenCalledTimes(1);
    const arg = h.usageUpsert.mock.calls[0][0];
    expect(arg.organizationId).toBe("org_1");
    expect(arg.balance).toBe(5000); // 5 Oblien credits → 5000 milli
    expect(arg.creditsUsed).toBe(2000);
    expect(arg.cpuTimeMinutes).toBe(120); // physical unit, not converted
  });

  it("credits.depleted → records audit + emits notification (Oblien owns the stop, we don't suspend)", async () => {
    h.orgFindById.mockResolvedValue({
      id: "org_1",
      subscriptionStatus: "active",
      planTierId: "pro",
      oblienNamespace: "os-abc",
    });
    const body = JSON.stringify({
      event: "credits.depleted",
      timestamp: "t1",
      data: { namespace: "os-abc" },
    });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.auditRecord).toHaveBeenCalledTimes(1);
    expect(h.notificationEmit).toHaveBeenCalledTimes(1);
  });

  it("namespace.quota.threshold → emails + emits", async () => {
    const body = JSON.stringify({
      event: "namespace.quota.threshold",
      data: { namespace: "os-abc", percent: 80, used: 8000, limit: 10000 },
    });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect(h.notificationEmit).toHaveBeenCalledTimes(1);
  });

  it("unrouted event → 200 no-op (no side effects)", async () => {
    const body = JSON.stringify({ event: "vm.stopped", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.usageUpsert).not.toHaveBeenCalled();
    expect(h.auditRecord).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("unknown namespace → 200 no-op", async () => {
    h.orgRows = [];
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-nope" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.usageUpsert).not.toHaveBeenCalled();
  });

  it.each(["payment.succeeded", "subscription.renewed", "subscription.tier_changed", "subscription.past_due", "subscription.canceled", "subscription.updated", "entitlement.changed", "namespace.restored"])("%s refreshes authoritative entitlement", async (event) => {
    const body = JSON.stringify({ event, data: { namespace: "os-abc", credits: 999999 } });
    expect(((await oblienWebhook(makeCtx(body, sign(body), "evt-1"))) as unknown as JsonResult).status).toBe(200);
    expect(h.sync).toHaveBeenCalledOnce();
  });

  it("deduplicates retries with the same X-Webhook-Id even if delivery timestamps change", async () => {
    for (const timestamp of ["first", "retry"]) {
      const body = JSON.stringify({ event: "payment.succeeded", timestamp, data: { namespace: "os-abc" } });
      await oblienWebhook(makeCtx(body, sign(body), "evt-stable"));
    }
    expect(h.sync).toHaveBeenCalledOnce();
  });

  it("deduplicates current signed body ids and rejects a replay with a changed header", async () => {
    const body = JSON.stringify({ id: "evt-current", event: "payment.succeeded", data: { namespace: "os-abc" } });
    expect(((await oblienWebhook(makeCtx(body, sign(body), "evt-current"))) as unknown as JsonResult).status).toBe(200);
    expect(((await oblienWebhook(makeCtx(body, sign(body), "evt-current"))) as unknown as JsonResult).status).toBe(200);
    expect(((await oblienWebhook(makeCtx(body, sign(body), "evt-replayed"))) as unknown as JsonResult).status).toBe(400);
    expect(h.sync).toHaveBeenCalledOnce();
    expect(h.processed.size).toBe(1);
  });

  it("returns 503 and does not acknowledge a failed synchronization", async () => {
    const body = JSON.stringify({ event: "payment.succeeded", data: { namespace: "os-abc" } });
    h.sync.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(((await oblienWebhook(makeCtx(body, sign(body), "evt-retry"))) as unknown as JsonResult).status).toBe(503);
    expect(h.processed.size).toBe(0);
    expect(((await oblienWebhook(makeCtx(body, sign(body), "evt-retry"))) as unknown as JsonResult).status).toBe(200);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it("does not announce credit exhaustion when a delayed suspension arrives after payment", async () => {
    h.sync.mockResolvedValue({ entitlement: { status: "active" } });
    const body = JSON.stringify({ event: "namespace.suspended", data: { namespace: "os-abc" } });
    await oblienWebhook(makeCtx(body, sign(body), "evt-late"));
    expect(h.notificationEmit).not.toHaveBeenCalled();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: { record: h.auditRecord } }));
