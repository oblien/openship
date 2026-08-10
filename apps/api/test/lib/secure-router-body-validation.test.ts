import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Type } from "@sinclair/typebox";

/**
 * `spec.body` is the single source of truth for a route's JSON body: secureRouter
 * auto-mounts `tbValidator("json", body)` from it (no separate manual validator,
 * no duplicated schema in an `mcp.body` block). This asserts the auto-wiring
 * actually validates — a wrong-shape body is a 400 before the handler runs, a
 * valid body reaches the handler, and a route with no `body` is untouched.
 */

vi.mock("../../src/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetMs: 60_000 })),
}));
vi.mock("../../src/config/env", () => ({ env: {} }));
vi.mock("../../src/middleware/auth", () => ({
  authMiddleware: (c: { set: (k: string, v: unknown) => void }, next: () => unknown) => {
    c.set("ctx", { userId: "user-1", organizationId: "org-1" });
    return next();
  },
}));
vi.mock("../../src/lib/request-context", () => ({
  getRequestContext: (c: { get: (k: string) => unknown }) => c.get("ctx"),
}));
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

const Body = Type.Object({ name: Type.String() });

function buildApp() {
  const app = new Hono();
  app.use("*", (c, n) => {
    c.set("clientIp" as never, "1.2.3.4");
    return n();
  });
  const r = secureRouter(new Hono(), { module: "t" });
  r.post("/with-body", { resource: "project", action: "write", body: Body } as never, async (c) =>
    c.json({ ok: true, got: await c.req.json() }),
  );
  r.post("/no-body", { resource: "project", action: "write" } as never, (c) => c.json({ ok: true }));
  app.route("/api/t", r.hono);
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("secureRouter auto-wires validation from spec.body", () => {
  it("accepts a well-formed body and reaches the handler", async () => {
    const res = await post(buildApp(), "/api/t/with-body", { name: "hello" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, got: { name: "hello" } });
  });

  it("rejects a wrong-shape body with 400 before the handler", async () => {
    const res = await post(buildApp(), "/api/t/with-body", { name: 123 });
    expect(res.status).toBe(400);
  });

  it("rejects a missing required field with 400", async () => {
    const res = await post(buildApp(), "/api/t/with-body", {});
    expect(res.status).toBe(400);
  });

  it("routes without spec.body are not validated", async () => {
    const res = await post(buildApp(), "/api/t/no-body", { anything: true });
    expect(res.status).toBe(200);
  });
});
