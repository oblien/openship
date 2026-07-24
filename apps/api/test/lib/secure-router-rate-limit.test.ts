import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * Regression for GitHub #123: rate-limiting lives in the per-route chain now.
 * secureRouter must inject a limiter AFTER authMiddleware, so:
 *   1. permission-tagged (authed) routes key on `default-authed` per USER
 *      (not the old `default-anon` per IP — the global limiter ran upstream of
 *      auth and never saw ctx), and
 *   2. each request charges exactly ONE bucket (the old global limiter double-
 *      charged routes that set their own policy).
 * We mock the rate-limit facade to capture the (policy, subject) each route
 * enforces and how many times.
 */

const { rateLimit } = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetMs: 60_000 })),
}));
vi.mock("../../src/lib/rate-limit", () => ({ rateLimit }));

// Minimal env so the rate-limiter loads without the full zod validation.
vi.mock("../../src/config/env", () => ({ env: {} }));

// authMiddleware sets ctx, so permission-tagged routes can key per-user.
vi.mock("../../src/middleware/auth", () => ({
  authMiddleware: (c: { set: (k: string, v: unknown) => void }, next: () => unknown) => {
    c.set("ctx", { userId: "user-1", organizationId: "org-1" });
    return next();
  },
}));

// The real contract: return c.var.ctx, throw if absent (unauthed route).
vi.mock("../../src/lib/request-context", () => ({
  getRequestContext: (c: { get: (k: string) => unknown }) => {
    const ctx = c.get("ctx");
    if (!ctx) throw new Error("no ctx");
    return ctx;
  },
}));

// Permission engine: allow everything; registry is a no-op. A spec is "public"
// iff it carries a `reason` (PublicSpec) rather than a `resource` (PermissionSpec).
vi.mock("../../src/lib/route-permission", () => ({
  requirePermission: () => (_c: unknown, next: () => unknown) => next(),
  publicRoute: () => (_c: unknown, next: () => unknown) => next(),
  registerRoute: () => {},
  isPublicSpec: (s: { reason?: unknown; resource?: unknown }) =>
    typeof s?.reason === "string" && !s?.resource,
}));

vi.mock("../../src/middleware/local-only", () => ({
  localOnly: (_c: unknown, next: () => unknown) => next(),
}));

import { secureRouter } from "../../src/lib/secure-router";

function buildApp() {
  const app = new Hono();
  app.use("*", (c, n) => {
    c.set("clientIp" as never, "1.2.3.4");
    return n();
  });
  const r = secureRouter(new Hono(), { module: "t" });
  r.get("/authed", { resource: "project", action: "read" } as never, (c) => c.json({ ok: true }));
  r.get("/pub", { reason: "public test" } as never, (c) => c.json({ ok: true }));
  r.get("/explicit", { resource: "project", action: "read", rateLimit: "mcp" } as never, (c) =>
    c.json({ ok: true }),
  );
  app.route("/api/t", r.hono);
  return app;
}

describe("secureRouter per-route rate-limit (issue #123)", () => {
  beforeEach(() => rateLimit.mockClear());

  it("authed route → default-authed keyed per USER (not default-anon per IP), charged once", async () => {
    const res = await buildApp().request("/api/t/authed");
    expect(res.status).toBe(200);
    expect(rateLimit).toHaveBeenCalledTimes(1); // no double-charge
    expect(rateLimit).toHaveBeenCalledWith({ policy: "default-authed", subjectId: "user-1" });
  });

  it("public route → default-anon keyed per IP, charged once", async () => {
    const res = await buildApp().request("/api/t/pub");
    expect(res.status).toBe(200);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledWith({ policy: "default-anon", subjectId: "1.2.3.4" });
  });

  it("explicit route policy wins, still charged once", async () => {
    const res = await buildApp().request("/api/t/explicit");
    expect(res.status).toBe(200);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ policy: "mcp" }));
  });
});
