import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  listByUser: vi.fn(),
  findMembership: vi.fn(),
  findOrganizations: vi.fn(),
}));

vi.mock("../../src/lib/auth", () => ({
  auth: {
    api: {
      getSession: h.getSession,
      getMcpSession: vi.fn(async () => null),
    },
  },
}));

vi.mock("../../src/config/env", () => ({ env: {}, trustedOrigins: [] }));
vi.mock("../../src/lib/local-user", () => ({ ensureLocalUser: vi.fn() }));
vi.mock("../../src/middleware/zero-auth-guard", () => ({ zeroAuthAllowed: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: {
    member: { listByUser: h.listByUser, find: h.findMembership },
    organization: { findManyById: h.findOrganizations },
    personalAccessToken: {},
    user: {},
  },
}));

const { authMiddleware } = await import("../../src/middleware/auth");

function appWithProtectedHandler() {
  const app = new Hono();
  const handler = vi.fn((c) => c.json({ ok: true }));
  app.use("*", authMiddleware);
  app.get("/", handler);
  return { app, handler };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getSession.mockResolvedValue({
    user: { id: "user_old", email: "old@example.com", name: "Old User" },
    session: { id: "session_old", activeOrganizationId: "org_old" },
  });
  h.findOrganizations.mockResolvedValue([]);
});

describe("auth middleware stale-session boundary", () => {
  it("returns 401 instead of running handlers without a RequestContext when memberships are gone", async () => {
    h.listByUser.mockResolvedValue([]);
    const { app, handler } = appWithProtectedHandler();

    const response = await app.request("/");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized", code: "SESSION_STALE" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 when the resolved membership disappears between resolution and context build", async () => {
    h.listByUser.mockResolvedValue([
      { id: "member_old", userId: "user_old", organizationId: "org_old", role: "owner" },
    ]);
    h.findMembership.mockResolvedValue(null);
    const { app, handler } = appWithProtectedHandler();

    const response = await app.request("/");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized", code: "SESSION_STALE" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still builds context and calls the handler for a current membership", async () => {
    h.listByUser.mockResolvedValue([
      { id: "member_1", userId: "user_old", organizationId: "org_old", role: "owner" },
    ]);
    h.findMembership.mockResolvedValue({ id: "member_1", role: "owner" });
    const { app, handler } = appWithProtectedHandler();

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});
