import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { createCloudAnalyticsRepo } from "../../../../../packages/db/src/repos/cloud-analytics.repo";
import {
  cloudAnalyticsEvent,
  cloudAnalyticsCheckout,
} from "../../../../../packages/db/src/schema/cloud-analytics";
import type { Database } from "@repo/db/factory";
import { CloudAnalytics, analyticsId } from "@repo/platform/engine/modules/cloud-analytics/service";
import type { CloudAnalyticsConfig } from "@repo/platform/engine/modules/cloud-analytics/config";
import type { CloudBrowserCapture } from "@repo/contracts";

const h = vi.hoisted(() => ({
  config: null as CloudAnalyticsConfig | null,
  analytics: null as unknown as CloudAnalytics,
  session: vi.fn(),
  organization: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/cloud-analytics/index", () => ({
  get cloudAnalytics() {
    return h.analytics;
  },
}));
vi.mock("@repo/platform/engine/modules/cloud-analytics/config", () => ({
  getCloudAnalyticsConfig: () => h.config,
}));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: h.session } } }));
vi.mock("../../../src/middleware/active-organization", () => ({
  resolveActiveOrganizationId: h.organization,
}));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { cloudAnalyticsRoutes } from "../../../src/modules/cloud-analytics/cloud-analytics.routes";

const config: CloudAnalyticsConfig = {
  key: "phc_test",
  host: "https://us.i.posthog.com",
  dashboardOrigin: "https://app.openship.io",
  excludedOrganizations: new Set(),
  excludedUsers: new Set(),
};
const actor = { organizationId: "org-test", userId: "user-one", source: "dashboard" as const };
let client: PGlite;
let db: ReturnType<typeof drizzle>;
let repo: ReturnType<typeof createCloudAnalyticsRepo>;
let now: Date;
let server: Server;
let receiver: string;
let received: Array<{
  api_key: string;
  batch: Array<{
    event: string;
    uuid: string;
    distinct_id: string;
    properties: Record<string, any>;
    timestamp: string;
  }>;
}>;
let status = 200;
const app = new Hono()
  .route("/api/cloud/telemetry", cloudAnalyticsRoutes)
  .post("/api/cloud/analytics", (c) => {
    // A connected client's existing traffic relay is registered after telemetry
    // in app.ts. Its bearer request must reach its own authentication/handler.
    if (c.req.header("authorization") !== "Bearer cloud-session") return c.body(null, 401);
    return c.json({ data: { requests: 42 } });
  });
const visitor: CloudBrowserCapture = {
  id: "11111111-1111-4111-a111-111111111111",
  anonymousId: "22222222-2222-4222-a222-222222222222",
  expectedUserId: null,
  attribution: { utm_source: "launch", utm_campaign: "v0.8.0" },
  data: { event: "cloud_page_viewed", properties: { screen: "signup", utm_source: "launch" } },
};
const request = (
  body: unknown,
  origin = config.dashboardOrigin,
  extra: Record<string, string> = {},
) =>
  app.request("/api/cloud/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin, ...extra },
    body: JSON.stringify(body),
  });
const rows = () => db.select().from(cloudAnalyticsEvent);

beforeAll(async () => {
  client = new PGlite("memory://");
  db = drizzle(client);
  await client.exec("CREATE TABLE organization (id text PRIMARY KEY)");
  await client.exec(
    readFileSync(
      new URL("../../../../../packages/db/drizzle/0151_cloud_analytics.sql", import.meta.url),
      "utf8",
    ),
  );
  repo = createCloudAnalyticsRepo(db as unknown as Database);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end('{"status":1}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiver = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await client.exec(
    "TRUNCATE organization CASCADE; INSERT INTO organization VALUES ('org-test'), ('org-other')",
  );
  now = new Date();
  received = [];
  status = 200;
  h.config = config;
  h.session.mockReset().mockResolvedValue(null);
  h.organization.mockReset().mockResolvedValue(actor.organizationId);
  h.analytics = new CloudAnalytics({
    config: () => h.config,
    repo,
    now: () => now,
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://us.i.posthog.com/batch/");
      expect(init?.redirect).toBe("error");
      return fetch(receiver, init);
    },
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.close();
});

describe("Cloud product analytics through HTTP, SQL outbox, and capture receiver", () => {
  it.each([false, true])("preserves the traffic analytics relay when telemetry is enabled: %s", async (enabled) => {
    h.config = enabled ? config : null;
    const response = await app.request("/api/cloud/analytics", {
      method: "POST",
      headers: { Authorization: "Bearer cloud-session", "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "requests", domain: "app.example.com" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { requests: 42 } });
    expect(h.session).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("links an anonymous launch visit to the authenticated user without sending credentials or URLs", async () => {
    expect((await request(visitor)).status).toBe(204);
    h.session.mockResolvedValue({
      user: { id: actor.userId },
      session: { activeOrganizationId: actor.organizationId },
    });
    expect(
      (
        await request({
          ...visitor,
          id: "33333333-3333-4333-a333-333333333333",
          expectedUserId: actor.userId,
        })
      ).status,
    ).toBe(204);
    await h.analytics.flush();
    const events = received.flatMap((batch) => batch.batch);
    expect(events).toHaveLength(3);
    expect(events.find((event) => event.event === "$identify")).toMatchObject({
      distinct_id: actor.userId,
      properties: {
        $anon_distinct_id: `anon:${visitor.anonymousId}`,
        $set_once: { initial_utm_source: "launch" },
        $groups: { workspace: actor.organizationId },
      },
    });
    expect(events.every((event) => event.properties.$geoip_disable)).toBe(true);
    const encoded = JSON.stringify(events);
    for (const forbidden of [
      "email",
      "session_token",
      "current_url",
      "referrer_url",
      "user_agent",
      "ip_address",
    ])
      expect(encoded).not.toContain(forbidden);
  });

  it("fails closed for local/disabled configs, external origins and bearer tokens", async () => {
    h.config = null;
    expect((await request(visitor)).status).toBe(404);
    h.config = config;
    expect((await request(visitor, "http://localhost:3001")).status).toBe(403);
    expect(
      (await request(visitor, config.dashboardOrigin, { Authorization: "Bearer secret" })).status,
    ).toBe(403);
    expect(h.session).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("rejects client payment events, arbitrary properties, large bodies and stale identities", async () => {
    for (const body of [
      {
        ...visitor,
        data: { event: "cloud_payment_succeeded", properties: { amount_cents: 90000 } },
      },
      {
        ...visitor,
        data: { event: "cloud_page_viewed", properties: { screen: "home", env: "password" } },
      },
      { ...visitor, organizationId: "org-other" },
    ])
      expect((await request(body)).status).toBe(400);
    expect((await request({ ...visitor, unexpected: "x".repeat(5000) })).status).toBe(413);
    h.session.mockResolvedValue({ user: { id: "different-user" }, session: {} });
    expect((await request({ ...visitor, expectedUserId: actor.userId })).status).toBe(204);
    h.organization.mockResolvedValue(null);
    expect((await request({ ...visitor, expectedUserId: "different-user" })).status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("does not turn checkout returns or unfulfilled/complimentary sessions into payments", async () => {
    await request({
      ...visitor,
      data: {
        event: "cloud_checkout_returned",
        properties: { kind: "subscription", result: "success" },
      },
    });
    await h.analytics.checkoutStarted(actor, {
      checkoutId: "cs_first",
      kind: "subscription",
      amount: 2000,
      plan: "pro",
      interval: "monthly",
    });
    for (const paymentStatus of ["unpaid", "no_payment_required"])
      await h.analytics.checkoutObserved(actor.organizationId, {
        id: "cs_first",
        kind: "subscription",
        status: "complete",
        paymentStatus,
        fulfilled: true,
        fulfillmentStatus: "completed",
      });
    await h.analytics.checkoutObserved(actor.organizationId, {
      id: "cs_first",
      kind: "subscription",
      status: "complete",
      paymentStatus: "paid",
      fulfilled: false,
      fulfillmentStatus: "pending",
    });
    expect((await rows()).map((row) => row.event).sort()).toEqual([
      "cloud_checkout_returned",
      "cloud_checkout_started",
    ]);
    expect(await repo.claimCheckouts(new Date(now.getTime() + 6 * 60_000))).toHaveLength(1);
  });

  it("deduplicates checkout creation/polling and payment/renewal retries, preserving the payer", async () => {
    const checkout = {
      checkoutId: "cs_same",
      kind: "subscription" as const,
      amount: 24000,
      plan: "pro",
      interval: "annual" as const,
    };
    await h.analytics.checkoutStarted(actor, checkout);
    await h.analytics.checkoutStarted({ ...actor, userId: "teammate" }, checkout);
    for (let i = 0; i < 3; i++) {
      await h.analytics.checkoutObserved(actor.organizationId, {
        id: checkout.checkoutId,
        kind: "subscription",
        status: "complete",
        paymentStatus: "paid",
        fulfilled: true,
        fulfillmentStatus: "completed",
      });
      await h.analytics.payment(actor, {
        paymentId: "pi_one",
        checkoutId: "cs_same",
        kind: "subscription",
        amount: 24000,
        renewed: i > 0,
      });
    }
    const events = await rows();
    expect(events.filter((row) => row.event === "cloud_payment_succeeded")).toHaveLength(1);
    expect(events.filter((row) => row.event === "cloud_checkout_started")).toHaveLength(1);
    expect(events.filter((row) => row.event === "cloud_checkout_completed")).toHaveLength(1);
    expect(events.filter((row) => row.event === "cloud_subscription_renewed")).toHaveLength(1);
    expect(events.every((row) => row.distinctId === actor.userId)).toBe(true);
    expect(JSON.stringify(events.map((row) => row.properties))).not.toContain("cs_same");
    expect((await db.select().from(cloudAnalyticsCheckout))[0]?.nextCheckAt).toBeNull();
  });

  it("keeps top-ups, recurring revenue and reversal observations distinct", async () => {
    await h.analytics.checkoutStarted(actor, {
      checkoutId: "cs_topup",
      kind: "topup",
      amount: 1000,
    });
    await h.analytics.payment(actor, {
      checkoutId: "cs_topup",
      paymentId: "pi_topup",
      kind: "topup",
      amount: 1000,
      renewed: false,
    });
    await h.analytics.checkoutObserved(actor.organizationId, {
      id: "cs_topup",
      kind: "topup",
      status: "complete",
      paymentStatus: "paid",
      fulfilled: true,
      fulfillmentStatus: "partially_refunded",
    });
    expect((await rows()).filter((row) => row.event === "cloud_payment_succeeded")).toHaveLength(1);
    expect(
      (await rows()).find((row) => row.event === "cloud_payment_succeeded")?.properties,
    ).toMatchObject({ kind: "topup", amount_cents: 1000 });
    expect(
      (await rows()).find((row) => row.event === "cloud_checkout_reversed")?.properties,
    ).not.toHaveProperty("amount_cents");
    expect((await rows()).some((row) => row.event === "cloud_subscription_changed")).toBe(false);
  });

  it("retries a PostHog outage with the original event IDs and timestamps after process replacement", async () => {
    await h.analytics.record(
      actor,
      "cloud_payment_succeeded",
      {
        payment_id: analyticsId("pi_test"),
        kind: "subscription",
        amount_cents: 2000,
        currency: "usd",
      },
      "payment:pi_test",
    );
    status = 503;
    await expect(h.analytics.flush()).resolves.toBeUndefined();
    expect((await rows())[0]?.deliveredAt).toBeNull();
    status = 200;
    now = new Date(now.getTime() + 61_000);
    const replacement = new CloudAnalytics({
      config: () => config,
      repo,
      now: () => now,
      fetch: (_url, init) => fetch(receiver, init),
    });
    await replacement.flush();
    expect(received).toHaveLength(2);
    expect(received[1]?.batch).toEqual(received[0]?.batch);
    expect((await rows())[0]?.deliveredAt).toBeInstanceOf(Date);
    await replacement.flush();
    expect(received).toHaveLength(2);
  });

  it("claims once across workers and ignores acknowledgements from an expired lease", async () => {
    await h.analytics.record(actor, "cloud_signup_completed", {}, "signup:one");
    const first = await repo.claim("worker-one", now);
    expect(first).toHaveLength(1);
    expect(await repo.claim("worker-two", now)).toHaveLength(0);
    now = new Date(now.getTime() + 61_000);
    expect(await repo.claim("worker-two", now)).toHaveLength(1);
    await repo.acknowledge(
      first.map((row) => row.id),
      "worker-one",
      now,
    );
    expect((await rows())[0]?.deliveredAt).toBeNull();
    await repo.acknowledge(
      first.map((row) => row.id),
      "worker-two",
      now,
    );
    expect((await rows())[0]?.deliveredAt).toBeInstanceOf(Date);
  });

  it("preserves state transitions without counting every subscription read or paid workspace member", async () => {
    const state = {
      plan: "pro",
      billing_source: "subscription" as const,
      status: "active" as const,
      interval: "annual" as const,
      cancel_at_period_end: false,
      paying: true,
      mrr_cents: 2000,
      currency: "usd" as const,
    };
    await Promise.all([
      h.analytics.subscription(actor.organizationId, state),
      h.analytics.subscription(actor.organizationId, { ...state }),
    ]);
    await h.analytics.subscription(actor.organizationId, { ...state, cancel_at_period_end: true });
    await h.analytics.subscription(actor.organizationId, state);
    const snapshots = (await rows()).filter((row) => row.event === "cloud_subscription_changed");
    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((row) => row.properties.revision).sort()).toEqual([1, 2, 3]);
    expect(snapshots.every((row) => row.distinctId === `workspace:${actor.organizationId}`)).toBe(
      true,
    );
  });

  it("attributes worker outcomes to the deploy initiator and records activation once per workspace", async () => {
    for (const id of ["dep-first", "dep-second"]) {
      await h.analytics.record(
        actor,
        "cloud_deployment_started",
        { project_id: "project", deployment_id: id },
        `deployment-started:${id}`,
      );
      h.analytics.deploymentOutcome({ organizationId: actor.organizationId }, true, {
        project_id: "project",
        deployment_id: id,
        duration_ms: 1500,
      });
      await h.analytics.drain();
    }
    const events = await rows();
    expect(events.filter((row) => row.event === "cloud_deployment_succeeded")).toHaveLength(2);
    expect(events.filter((row) => row.event === "cloud_first_deployment_succeeded")).toHaveLength(
      1,
    );
    expect(events.every((row) => row.distinctId === actor.userId)).toBe(true);
  });

  it("ignores unsupported properties and configuration failures without touching product data", async () => {
    expect(
      await h.analytics.record(actor, "cloud_project_created", {
        project_id: "project",
        env: { SECRET: "hidden" },
      } as any),
    ).toBe(false);
    const disabled = new CloudAnalytics({
      config: () => {
        throw new Error("unavailable config");
      },
      repo,
    });
    expect(() => disabled.capture(actor, "cloud_signup_completed", {})).not.toThrow();
    await expect(disabled.flush()).resolves.toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it("excludes internal workspaces on collection and on delayed delivery", async () => {
    await h.analytics.record(actor, "cloud_signup_completed", {}, "before-exclusion");
    h.config = { ...config, excludedOrganizations: new Set([actor.organizationId]) };
    await h.analytics.checkoutStarted(actor, {
      checkoutId: "cs_ignored",
      kind: "topup",
      amount: 100,
    });
    await h.analytics.flush();
    expect(received).toHaveLength(0);
    expect(await db.select().from(cloudAnalyticsCheckout)).toHaveLength(0);
  });

  it("does not mark checkout reconciliation finished if its event could not be persisted", async () => {
    await h.analytics.checkoutStarted(actor, {
      checkoutId: "cs_retry",
      kind: "topup",
      amount: 100,
    });
    const fail = vi.spyOn(repo, "enqueue").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      h.analytics.checkoutObserved(actor.organizationId, {
        id: "cs_retry",
        kind: "topup",
        status: "complete",
        paymentStatus: "paid",
        fulfilled: true,
        fulfillmentStatus: "completed",
      }),
    ).resolves.toBeUndefined();
    expect((await db.select().from(cloudAnalyticsCheckout))[0]?.nextCheckAt).not.toBeNull();
    fail.mockRestore();
  });

  it("prunes old browser deliveries while retaining financial receipts and unsent events", async () => {
    await request(visitor);
    await h.analytics.record(actor, "cloud_operation_failed", { operation: "deployment", status: 503, reason: "unavailable" });
    await h.analytics.record(
      actor,
      "cloud_payment_succeeded",
      {
        payment_id: analyticsId("pi_keep"),
        kind: "subscription",
        amount_cents: 2000,
        currency: "usd",
      },
      "payment:pi_keep",
    );
    await h.analytics.flush();
    await repo.prune(new Date(now.getTime() + 31 * 24 * 60 * 60_000));
    expect((await rows()).map((row) => row.event)).toEqual(["cloud_payment_succeeded"]);
    await h.analytics.payment(actor, {
      paymentId: "pi_keep",
      kind: "subscription",
      amount: 2000,
      renewed: false,
    });
    expect(await rows()).toHaveLength(1);
  });
});
