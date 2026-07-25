import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { floodGuard, rateLimiterFor } from "../../src/middleware/rate-limiter";
import { POLICIES } from "../../src/lib/rate-limit/policies";

// The pre-auth flood guard (#123 follow-up): with the global /api limiter gone,
// nothing throttled requests before authMiddleware's session lookup. floodGuard
// re-adds a coarse per-IP ceiling ahead of every route chain, as its OWN bucket
// so it never double-charges the per-route policies that run after auth.
//
// A Hono app with a fixed clientIp reproduces the mounted order (floodGuard is
// app-level, per-route limiters run downstream). No TRUST_PROXY needed — a
// non-loopback clientIp isn't caught by enforce()'s loopback exemption.

function withIp(ip: string) {
  return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("clientIp", ip);
    await next();
  };
}

describe("flood-ip policy", () => {
  it("is a per-IP ceiling set above the most generous per-user policy", () => {
    const flood = POLICIES["flood-ip"];
    expect(flood.subject).toBe("ip");
    // Must not clip a single legitimate authed client below its own allowance:
    // the guard's limit sits at or above default-authed's per-user ceiling.
    expect(flood.limit).toBeGreaterThanOrEqual(POLICIES["default-authed"].limit);
  });
});

describe("floodGuard middleware", () => {
  it("applies the flood-ip ceiling to an ordinary /api request", async () => {
    const app = new Hono();
    app.use("*", withIp("203.0.113.10"));
    app.use("/api/*", floodGuard);
    app.get("/api/projects", (c) => c.json({ ok: true }));

    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(POLICIES["flood-ip"].limit));
  });

  it("exempts /api/health so probes and SSR renders never trip it", async () => {
    const app = new Hono();
    app.use("*", withIp("203.0.113.11"));
    app.use("/api/*", floodGuard);
    app.get("/api/health/env", (c) => c.json({ ok: true }));

    const res = await app.request("/api/health/env");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("counts per IP and keeps distinct IPs independent", async () => {
    const app = new Hono();
    let ip = "203.0.113.20";
    app.use("*", (c, next) => {
      c.set("clientIp", ip);
      return next();
    });
    app.use("/api/*", floodGuard);
    app.get("/api/projects", (c) => c.json({ ok: true }));

    const remaining = async () =>
      Number((await app.request("/api/projects")).headers.get("X-RateLimit-Remaining"));

    const first = await remaining();
    const second = await remaining();
    expect(second).toBe(first - 1); // same IP decrements

    ip = "203.0.113.21";
    const other = await remaining();
    expect(other).toBe(first); // a fresh IP starts full
  });

  it("does not suppress a downstream per-route limiter and uses a separate bucket", async () => {
    // floodGuard then a route limiter, same request/IP — the response must show
    // the ROUTE policy's headers (downstream ran), and the two buckets must
    // count independently (the #123 no-double-charge invariant).
    const app = new Hono();
    app.use("*", withIp("203.0.113.30"));
    app.use("/api/*", floodGuard);
    app.get("/api/plain", rateLimiterFor("default-anon"), (c) => c.json({ ok: true }));

    const r1 = await app.request("/api/plain");
    expect(r1.headers.get("X-RateLimit-Limit")).toBe(String(POLICIES["default-anon"].limit));
    expect(r1.headers.get("X-RateLimit-Remaining")).toBe(
      String(POLICIES["default-anon"].limit - 1),
    );

    const r2 = await app.request("/api/plain");
    // default-anon decremented by exactly one per request — flood-ip's charges
    // on the same IP did not drain the default-anon bucket.
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe(
      String(POLICIES["default-anon"].limit - 2),
    );
  });
});
