/**
 * Malformed JSON request bodies must return 400, not 500.
 *
 * Many controllers call `c.req.json()` on routes that have no `tbValidator`
 * (~124 call sites). Hono's `c.req.json()` throws a `SyntaxError` on an
 * invalid body; if `handleApiError` doesn't recognize it, the request falls
 * through to the unknown-error branch and returns a 500 with a logged stack —
 * a client input error mislabeled as a server fault.
 */

import { describe, test, expect } from "vitest";
import { Hono } from "hono";
import { handleApiError } from "@/middleware/error-handler";
import { AppError, OperationError } from "@repo/contracts";

function makeApp() {
  const app = new Hono();
  app.onError(handleApiError);
  // Mirrors an unvalidated mutation route, e.g. POST /api/tokens/mcp-authorize.
  app.post("/echo", async (c) => {
    const body = await c.req.json<{ ok?: boolean }>();
    return c.json({ received: body });
  });
  return app;
}

describe("handleApiError — malformed JSON body", () => {
  test("exposes explicit operation recovery details while keeping canonical error fields authoritative", async () => {
    const app = makeApp();
    app.get("/failure", () => {
      throw new OperationError("Cleanup failed", 409, "PROJECT_TEARDOWN_FAILED", {
        canForceOrphan: true,
        error: "ignored",
        code: "ignored",
      });
    });
    const response = await app.request("/failure");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Cleanup failed",
      code: "PROJECT_TEARDOWN_FAILED",
      canForceOrphan: true,
    });
  });

  test("does not expose arbitrary provider error properties as public recovery details", async () => {
    const app = makeApp();
    app.get("/failure", () => {
      throw Object.assign(new AppError("Provider denied", 403, "PROVIDER_DENIED"), {
        details: { credential: "secret" },
      });
    });
    const response = await app.request("/failure");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Provider denied", code: "PROVIDER_DENIED" });
  });
  test("returns 400 (not 500) for a syntactically invalid body", async () => {
    const app = makeApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{", // malformed
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/json/i);
  });

  test("still parses a valid JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: { ok: true } });
  });
});
