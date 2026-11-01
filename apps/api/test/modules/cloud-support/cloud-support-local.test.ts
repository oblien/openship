import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { AppError } from "@repo/core";
import { CLOUD_SUPPORT_ACCOUNT_HEADER, SDK_SCOPE_HEADER } from "@repo/contracts";
import type { ExecutionContext } from "@repo/platform";
import type { StoredCloudSession } from "@repo/platform/engine/lib/cloud/types";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "docker" },
  customer: null as ExecutionContext | null,
  settings: new Map<string, string>(),
  ownerLookup: vi.fn(),
  upstream: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: h.env,
  cloudRuntimeTarget: { api: "https://cloud.example.test" },
  cloudRuntimeTargetId: "support-test-cloud",
}));
vi.mock("@repo/platform/engine/config/index", () => ({ env: h.env }));
vi.mock("@repo/db", async (original) => {
  const actual = await original<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      settings: {
        ...actual.repos.settings,
        findByUser: async (userId: string) => ({
          cloudSessionToken: h.settings.get(userId) ?? null,
        }),
        findOrgOwnerCloudLink: h.ownerLookup,
      },
    },
  };
});
// Isolate encryption at rest; exercise the real connection parser and transport.
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: (value: string) => value }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("../../../src/middleware/auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    if (!h.customer) return c.json({ error: "Unauthorized" }, 401);
    c.set("ctx", h.customer);
    await next();
  },
}));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => async (_c: Context, next: Next) => next(),
}));

const localUser = (id = "local-owner"): ExecutionContext => ({
  userId: id,
  user: { id, email: `${id}@local.test`, name: "Local user" },
  organizationId: "local-team",
  membershipId: `member-${id}`,
  role: "owner",
  sessionId: "local-session",
  sessionKind: "cookie",
  clientIp: null,
  userAgent: null,
  traceId: "support-link-test",
});
const connection = (userId = "cloud-owner", token = "test-cloud-session"): StoredCloudSession => ({
  userId,
  token,
  organizationId: "cloud-team",
  apiUrl: "https://cloud.example.test",
});
const account = (id = "cloud-owner") => ({
  id,
  key: id,
  name: "Cloud user",
  email: `${id}@cloud.test`,
});
const ticket = {
  id: "SUP-123456789012345678901234",
  category: "deployment",
  subject: "Deployment needs help",
  status: "open",
  createdAt: "2026-10-06T09:00:00Z",
  updatedAt: "2026-10-06T09:00:00Z",
};
const input = () => ({
  requestId: randomUUID(),
  category: "deployment",
  subject: ticket.subject,
  message: "Build failed",
});
const receipt = { id: ticket.id, createdAt: ticket.createdAt };
const detail = { ticket: { ...ticket, message: "Build failed" }, messages: [] };
let app: Hono;
const call = (path: string, method = "GET", body?: unknown, key?: string) =>
  app.request(`/api/cloud/support${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: "local-cookie=must-stay-local",
      "X-Organization-Id": "local-team",
      "X-Internal-Token": "must-not-be-forwarded",
      ...(key ? { [CLOUD_SUPPORT_ACCOUNT_HEADER]: key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
async function linkedKey() {
  const response = await call("/session");
  expect(response.status).toBe(200);
  return (await response.json()).account.key as string;
}

beforeAll(async () => {
  const { cloudSupportLocalRoutes } =
    await import("../../../src/modules/cloud-support/cloud-support-local.routes");
  app = new Hono().onError((error, c) =>
    c.json(
      {
        error: error instanceof AppError ? error.message : "Unavailable",
        code: error instanceof AppError ? error.code : "ERROR",
      },
      (error instanceof AppError ? error.statusCode : 500) as 400,
    ),
  );
  app.route("/api/cloud/support", cloudSupportLocalRoutes);
}, 30_000);
beforeEach(() => {
  vi.clearAllMocks();
  h.env.CLOUD_MODE = false;
  h.customer = localUser();
  h.settings.clear();
  h.settings.set("local-owner", JSON.stringify(connection()));
  h.ownerLookup.mockResolvedValue({ userId: "local-owner" });
  vi.stubGlobal("fetch", h.upstream);
  h.upstream.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    const cloudUser = headers.get(CLOUD_SUPPORT_ACCOUNT_HEADER)!;
    if (path.endsWith("/session")) return Response.json({ account: account(cloudUser) });
    if (path.endsWith("/mine"))
      return Response.json(
        init.method === "POST" ? receipt : { tickets: [ticket], nextCursor: null },
        { status: init.method === "POST" ? 201 : 200 },
      );
    return Response.json(detail, { status: init.method === "POST" ? 201 : 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("private support from a Cloud-connected local instance", () => {
  it("uses the verified personal Cloud identity for the full customer flow", async () => {
    const session = await (await call("/session")).json();
    expect(session.account).toMatchObject({ id: "cloud-owner", email: "cloud-owner@cloud.test" });
    expect(JSON.stringify(session)).not.toContain("test-cloud-session");
    const key = session.account.key;
    for (const [path, method, body, status, expected] of [
      [
        "/mine?search=build%20%26%20deploy&limit=2",
        "GET",
        undefined,
        200,
        { tickets: [ticket], nextCursor: null },
      ],
      ["/mine", "POST", input(), 201, receipt],
      [`/mine/${ticket.id}`, "GET", undefined, 200, detail],
      [
        `/mine/${ticket.id}/replies`,
        "POST",
        { requestId: randomUUID(), message: "Please help" },
        201,
        detail,
      ],
      [`/mine/${ticket.id}`, "PATCH", { status: "resolved" }, 200, detail],
    ] as const) {
      const result = await call(path, method, body, key);
      expect(result.status).toBe(status);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(await result.json()).toEqual(expected);
    }
    for (const [url, init] of h.upstream.mock.calls as [string, RequestInit][]) {
      expect(new URL(url).origin).toBe("https://cloud.example.test");
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-cloud-session");
      expect(headers.get("X-Organization-Id")).toBe("cloud-team");
      expect(headers.get(SDK_SCOPE_HEADER)).toBe("fixed");
      expect(headers.get(CLOUD_SUPPORT_ACCOUNT_HEADER)).toBe("cloud-owner");
      for (const name of ["Cookie", "Origin", "X-Internal-Token"])
        expect(headers.has(name)).toBe(false);
      expect(init.redirect).toBe("error");
    }
    expect(new URL(h.upstream.mock.calls[1]![0]).searchParams.get("search")).toBe("build & deploy");
    expect(h.ownerLookup).not.toHaveBeenCalled();
  });

  it("does not expose the org owner's inbox to teammates, including other local owners", async () => {
    h.customer = localUser("local-teammate");
    expect(await (await call("/session")).json()).toEqual({ account: null });
    expect((await call("/mine", "GET", undefined, "guessed-owner-key")).status).toBe(409);
    expect(h.upstream).not.toHaveBeenCalled();
    expect(h.ownerLookup).not.toHaveBeenCalled();
    h.settings.set(
      "local-teammate",
      JSON.stringify(connection("cloud-teammate", "teammate-session")),
    );
    expect((await (await call("/session")).json()).account.id).toBe("cloud-teammate");
  });

  it("rejects absent/API/native credentials while allowing the authenticated local zero-auth identity", async () => {
    const key = await linkedKey();
    h.upstream.mockClear();
    h.customer = null;
    expect((await call("/session")).status).toBe(401);
    for (const auth of [
      { sessionKind: "bearer" },
      { sessionKind: "native" },
      { sessionKind: "cookie", principalKind: "pat" },
      { sessionKind: "cookie", principalKind: "oauth" },
      { sessionKind: "cookie", tokenScope: { tokenId: "api-token" } },
    ] as const) {
      h.customer = { ...localUser(), ...auth };
      expect((await call("/session")).status).toBe(403);
      expect((await call("/mine", "POST", input(), key)).status).toBe(403);
    }
    expect(h.upstream).not.toHaveBeenCalled();
    h.customer = { ...localUser(), sessionKind: "zero-auth" };
    expect((await call("/mine", "GET", undefined, key)).status).toBe(200);
  });

  it("rejects an old or missing connection binding before sending a draft to a new account", async () => {
    const key = await linkedKey();
    h.upstream.mockClear();
    expect((await call("/mine", "POST", input())).status).toBe(409);
    h.settings.set("local-owner", JSON.stringify(connection("another-cloud-user", "new-session")));
    const rejected = await call("/mine", "POST", input(), key);
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("SUPPORT_ACCOUNT_CHANGED");
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it("discards a response that completed after the local user reconnected", async () => {
    const key = await linkedKey();
    h.upstream.mockImplementationOnce(async () => {
      h.settings.set(
        "local-owner",
        JSON.stringify(connection("another-cloud-user", "new-session")),
      );
      return Response.json({ tickets: [ticket], nextCursor: null });
    });
    const response = await call("/mine", "GET", undefined, key);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain(ticket.subject);
  });

  it("preserves the request ID on uncertain retries and forwards Cloud's rate-limit feedback", async () => {
    const key = await linkedKey();
    const body = input();
    h.upstream.mockRejectedValueOnce(new TypeError("Connection lost after commit"));
    expect((await call("/mine", "POST", body, key)).status).toBe(502);
    expect(await (await call("/mine", "POST", body, key)).json()).toEqual(receipt);
    const writes = h.upstream.mock.calls.filter(([, init]) => init.method === "POST");
    expect(writes.map(([, init]) => JSON.parse(init.body))).toEqual([body, body]);
    h.upstream.mockResolvedValueOnce(
      Response.json(
        { error: "quota", internal: "must-stay-private" },
        {
          status: 429,
          headers: { "Retry-After": "120", "Set-Cookie": "upstream-session=private" },
        },
      ),
    );
    const limited = await call("/mine", "POST", input(), key);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("120");
    expect(limited.headers.has("Set-Cookie")).toBe(false);
    expect(JSON.stringify(await limited.json())).not.toContain("must-stay-private");
  });

  it("keeps the deployment connection after a support auth failure and filters invalid responses", async () => {
    const key = await linkedKey();
    const saved = h.settings.get("local-owner");
    h.upstream.mockResolvedValueOnce(
      Response.json({ error: "expired", token: "private" }, { status: 401 }),
    );
    const expired = await call("/mine", "GET", undefined, key);
    expect(expired.status).toBe(401);
    expect((await expired.json()).code).toBe("SUPPORT_CLOUD_SESSION_REQUIRED");
    expect(h.settings.get("local-owner")).toBe(saved);
    for (const response of [
      new Response("<html>Provider error</html>"),
      Response.json({ tickets: [ticket], nextCursor: null, privateOutbox: [] }),
      Response.json({ tickets: [ticket], nextCursor: null }, { status: 201 }),
    ]) {
      h.upstream.mockResolvedValueOnce(response);
      expect((await call("/mine", "GET", undefined, key)).status).toBe(502);
    }
    h.upstream.mockResolvedValueOnce(Response.json({ account: account("unexpected-account") }));
    expect((await call("/session")).status).toBe(502);
  });

  it("bounds and validates requests, with no public intake or operator relay", async () => {
    const key = await linkedKey();
    h.upstream.mockClear();
    for (const [path, method, body, status] of [
      ["/mine", "POST", { ...input(), ownerUserId: "someone-else" }, 400],
      ["/mine?limit=999", "GET", undefined, 400],
      ["/mine?ownerUserId=someone-else", "GET", undefined, 400],
      ["/mine/invalid-id", "GET", undefined, 400],
      ["/mine", "POST", { ...input(), message: "x".repeat(66_000) }, 413],
      ["/", "POST", input(), 404],
      ["/tickets", "GET", undefined, 404],
      [
        `/tickets/${ticket.id}/replies`,
        "POST",
        { requestId: randomUUID(), message: "operator", resolve: true },
        404,
      ],
    ] as const)
      expect((await call(path, method, body, key)).status).toBe(status);
    expect(h.upstream).not.toHaveBeenCalled();
    h.env.CLOUD_MODE = true;
    expect((await call("/session")).status).toBe(404);
  });
});
