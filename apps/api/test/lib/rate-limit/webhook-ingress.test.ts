import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MemoryRateLimitStore } from "../../../src/lib/rate-limit/memory-store";
import { POLICIES, type PolicyId } from "../../../src/lib/rate-limit/policies";

const boundary = vi.hoisted(() => ({
  check: null as null | ((input: { policy: PolicyId; subjectId: string }) => Promise<unknown>),
}));
vi.mock("../../../src/lib/rate-limit", () => ({
  rateLimit: (input: { policy: PolicyId; subjectId: string }) => boundary.check!(input),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: { CLOUD_MODE: true, TRUST_PROXY: true },
}));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => {
    throw new Error("Public webhook");
  },
}));
import { rateLimiter, rateLimiterFor } from "../../../src/middleware/rate-limiter";

let store: MemoryRateLimitStore;
let keys: string[];
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000);
  store = new MemoryRateLimitStore();
  keys = [];
  boundary.check = async ({ policy, subjectId }) => {
    const key = `${policy}:${subjectId}`;
    keys.push(key);
    return store.checkAndIncrement(key, POLICIES[policy].windowMs, POLICIES[policy].limit);
  };
});
afterEach(async () => {
  await store.dispose();
  vi.restoreAllMocks();
});

function app() {
  const root = new Hono();
  root.use("*", (c, next) => {
    c.set("clientIp" as never, c.req.header("x-fixture-ip") ?? "192.0.2.1");
    return next();
  });
  const routes = new Hono();
  for (const path of ["/incoming/:id", "/backup", "/:provider"]) {
    routes.post(path, rateLimiterFor("webhook-ingress"), rateLimiter, (c) =>
      c.json({ accepted: true }),
    );
  }
  root.route("/api/webhooks", routes);
  return root;
}

async function fill(application: Hono, path: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < POLICIES["webhook-ingress"].limit; i++) {
    const response = await application.request(path, { method: "POST", headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("120");
  }
}

describe("webhook quotas behind shared IPs", () => {
  it("limits one incoming hook without rejecting another hook or provider at the same address", async () => {
    const application = app();
    await fill(application, "/api/webhooks/incoming/hook-one");
    const rejected = await application.request("/api/webhooks/incoming/hook-one?attempt=2", {
      method: "POST",
    });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("60");
    expect(rejected.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(
      (await application.request("/api/webhooks/incoming/hook-two", { method: "POST" })).status,
    ).toBe(200);
    expect((await application.request("/api/webhooks/github", { method: "POST" })).status).toBe(
      200,
    );
    expect(
      (
        await application.request("/api/webhooks/incoming/hook-one", {
          method: "POST",
          headers: { "x-fixture-ip": "192.0.2.2" },
        })
      ).status,
    ).toBe(200);
  });

  it("partitions registered GitHub hooks by stable hook ID, never delivery ID or query string", async () => {
    const application = app();
    await fill(application, "/api/webhooks/github", { "x-github-hook-id": "12345" });
    expect(
      (
        await application.request("/api/webhooks/github?delivery=different", {
          method: "POST",
          headers: { "x-github-hook-id": "12345", "x-github-delivery": "new-delivery" },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await application.request("/api/webhooks/github", {
          method: "POST",
          headers: { "x-github-hook-id": "67890" },
        })
      ).status,
    ).toBe(200);
    await fill(application, "/api/webhooks/stripe");
    expect(
      (
        await application.request("/api/webhooks/stripe", {
          method: "POST",
          headers: { "x-github-hook-id": "spoofed-stripe-partition" },
        })
      ).status,
    ).toBe(429);
  });

  it("keeps backup credentials out of cache keys while separating real backup endpoints", async () => {
    const application = app();
    const token = "fixture-private-backup-credential";
    await fill(application, "/api/webhooks/backup", { authorization: `Bearer ${token}` });
    expect(
      (
        await application.request("/api/webhooks/backup", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await application.request("/api/webhooks/backup", {
          method: "POST",
          headers: { authorization: "Bearer other-fixture-backup" },
        })
      ).status,
    ).toBe(200);
    expect(keys.some((key) => key.includes(token) || key.includes("other-fixture-backup"))).toBe(
      false,
    );
  });

  it("bounds an unauthenticated flood even when endpoint hints rotate", async () => {
    const application = app();
    const ceiling = POLICIES["webhook-flood"];
    for (let i = 0; i < ceiling.limit; i++) {
      await store.checkAndIncrement("webhook-flood:192.0.2.1", ceiling.windowMs, ceiling.limit);
    }
    for (const path of ["incoming/unseen-one", "incoming/unseen-two", "github", "backup"]) {
      const response = await application.request(`/api/webhooks/${path}`, {
        method: "POST",
        headers: { "x-github-hook-id": "98765", authorization: "Bearer new-token" },
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("6000");
    }
  });
});
