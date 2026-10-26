import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAffiliateOperations } from "../../../../packages/platform/src/affiliates";
import type { Authorization } from "@repo/platform";
import { freezeContext } from "@repo/platform";
import { AffiliateRoutes } from "@repo/contracts";
import { unavailableAffiliateOverview } from "@repo/platform/engine/modules/affiliates/affiliate-provider";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  collection: vi.fn(),
  kernel: {} as Record<string, unknown>,
}));
vi.mock("@repo/platform/engine/lib/platform", () => ({ getPlatformKernel: () => h.kernel }));
vi.mock("../../src/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetMs: 60000 })),
}));
vi.mock("../../src/middleware/auth", () => ({
  authMiddleware: (...args: unknown[]) => h.auth(...args),
}));

import { affiliateRoutes } from "../../src/modules/affiliates/affiliate.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { scanRoutes } from "../../src/lib/route-scanner";

const ctx = freezeContext({
  userId: "alice",
  user: { id: "alice", email: "alice@example.test", name: null },
  organizationId: "workspace",
  role: "member",
  membershipId: "member",
  sessionId: "session",
  sessionKind: "cookie",
  clientIp: "127.0.0.1",
  userAgent: null,
  traceId: "affiliate-test",
});
const app = new Hono().onError(handleApiError).route("/api/affiliates", affiliateRoutes);
const request = (
  path = "",
  body?: unknown,
  headers: Record<string, string> = { "x-user": "alice" },
) =>
  app.request(`/api/affiliates${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockImplementation((c, next) => {
    if (!c.req.header("x-user")) return c.json({ error: "Sign in" }, 401);
    c.set("ctx", {
      ...ctx,
      ...(c.req.header("x-project-token") ? { tokenScope: { tokenId: "project" } } : {}),
      ...(c.req.header("x-read-only")
        ? { credential: { readOnly: true, organizationId: null } }
        : {}),
    });
    return next();
  });
  h.collection.mockResolvedValue(unavailableAffiliateOverview());
  const authorization = { resolveScope: async () => ctx } as unknown as Authorization;
  h.kernel = {
    affiliates: createAffiliateOperations(authorization, {
      collection: {
        overview: h.collection,
        enroll: h.collection,
        offers: h.collection,
        requestPayout: h.collection,
      } as never,
    }),
  };
});

describe("affiliate HTTP authority", () => {
  it("boots with every shared route classified and authenticates exactly once", async () => {
    expect(scanRoutes(app).errors).toEqual([]);
    for (const route of Object.values(AffiliateRoutes))
      expect(
        app.routes.some(
          (r) => r.method === route.method && r.path.replace(/\/$/, "") === `/api${route.path}`,
        ),
      ).toBe(true);
    expect((await request("", undefined, {})).status).toBe(401);
    expect(h.collection).not.toHaveBeenCalled();
    h.auth.mockClear();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(h.auth).toHaveBeenCalledTimes(1);
    expect(h.collection).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "alice", role: "member" }),
      undefined,
    );
  });

  it("denies scoped credentials and read-only payout requests before provider access", async () => {
    expect(
      (await request("", undefined, { "x-user": "alice", "x-project-token": "1" })).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/payouts",
          { amountCents: 5000, idempotencyKey: "payout-request-123" },
          { "x-user": "alice", "x-read-only": "1" },
        )
      ).status,
    ).toBe(403);
    expect(h.collection).not.toHaveBeenCalled();
  });

  it("rejects forged identity and commercial terms and exposes no operator route", async () => {
    for (const field of ["participantKey", "namespace", "minimumCents", "status", "userId"]) {
      expect(
        (
          await request("/payouts", {
            amountCents: 5000,
            idempotencyKey: "payout-request-123",
            [field]: "forged",
          })
        ).status,
      ).toBe(400);
    }
    expect((await request("/payouts/review", { status: "paid" })).status).toBe(404);
    expect((await request("/payouts/queue")).status).toBe(404);
    expect(h.collection).not.toHaveBeenCalled();
  });

  it("validates pagination then sends the numeric values through the shared operation", async () => {
    h.collection.mockResolvedValue({ items: [], total: 0 });
    expect((await request("/offers?limit=10&offset=20")).status).toBe(200);
    expect(h.collection).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice" }), {
      limit: 10,
      offset: 20,
    });
    h.collection.mockClear();
    expect((await request("/offers?limit=bad")).status).toBe(400);
    expect((await request("/offers?namespace=another")).status).toBe(400);
    expect(h.collection).not.toHaveBeenCalled();
  });
});
