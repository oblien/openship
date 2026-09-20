import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { handleApiError } from "../../src/middleware/error-handler";

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  listByUser: vi.fn(),
  findMembership: vi.fn(),
  findOrganizations: vi.fn(),
  findActivePat: vi.fn(),
  findUser: vi.fn(),
  touchPat: vi.fn(),
  findInstanceRole: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: {
    api: {
      getSession: h.getSession,
      getMcpSession: vi.fn(async () => null),
    },
  },
}));

vi.mock("@repo/platform/engine/config/env", () => ({ env: {}, trustedOrigins: [] }));
vi.mock("../../src/lib/local-user", () => ({ ensureLocalUser: vi.fn() }));
vi.mock("../../src/middleware/zero-auth-guard", () => ({ zeroAuthAllowed: vi.fn() }));
vi.mock("@repo/db", () => ({
  schema: { user: { id: "id", role: "role" } },
  eq: (_column: unknown, value: unknown) => value,
  db: { select: () => ({ from: () => ({ where: () => ({ limit: h.findInstanceRole }) }) }) },
  repos: {
    member: { listByUser: h.listByUser, find: h.findMembership },
    organization: { findManyById: h.findOrganizations },
    personalAccessToken: { findActiveByHash: h.findActivePat, touchLastUsed: h.touchPat },
    user: { findById: h.findUser },
  },
}));

const { authMiddleware } = await import("../../src/middleware/auth");
const { requireInstanceAdmin } = await import("../../src/middleware/instance-admin");

function appWithProtectedHandler() {
  const app = new Hono();
  app.onError(handleApiError);
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
  h.findActivePat.mockResolvedValue(null);
  h.findUser.mockResolvedValue({ id: "user_old", email: "old@example.com", name: "Old User" });
  h.touchPat.mockResolvedValue(undefined);
  h.findInstanceRole.mockResolvedValue([{ role: "user" }]);
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

  it("resolves an SDK's fixed organization explicitly instead of using the session's default", async () => {
    h.findMembership.mockResolvedValue({ id: "member-selected", role: "restricted" });
    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/", (c) => {
      const ctx = c.get("ctx");
      return c.json({
        organizationId: ctx.organizationId,
        scopeMode: ctx.scopeMode,
        role: ctx.role,
      });
    });
    const response = await app.request("/", {
      headers: { "X-Openship-Scope": "fixed", "X-Organization-Id": "org-selected" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizationId: "org-selected",
      scopeMode: "fixed",
      role: "restricted",
    });
    expect(h.findMembership).toHaveBeenCalledWith("org-selected", "user_old");
    expect(h.listByUser).not.toHaveBeenCalled();
  });

  it("does not fall back to an allowed organization when a requested fixed scope is denied", async () => {
    h.findMembership.mockResolvedValue(null);
    const { app, handler } = appWithProtectedHandler();
    const response = await app.request("/", {
      headers: { "X-Openship-Scope": "fixed", "X-Organization-Id": "org-foreign" },
    });
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["", "resource", "fiexed", "fixed, resource"])("rejects the unsupported scope value %j before selecting a default organization", async value => {
    h.listByUser.mockResolvedValue([{ id: "member", userId: "user_old", organizationId: "org_old", role: "owner" }]);
    h.findMembership.mockResolvedValue({ id: "member", role: "owner" });
    const { app, handler } = appWithProtectedHandler();
    const response = await app.request("/", {
      headers: { "X-Openship-Scope": value, "X-Organization-Id": "org_old" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.listByUser).not.toHaveBeenCalled();
    expect(h.findMembership).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("requires an explicit organization for fixed scope instead of defaulting from %j", async organizationId => {
    h.listByUser.mockResolvedValue([{ id: "member", userId: "user_old", organizationId: "org_old", role: "owner" }]);
    h.findMembership.mockResolvedValue({ id: "member", role: "owner" });
    const { app, handler } = appWithProtectedHandler();
    const headers = new Headers({ "X-Openship-Scope": "fixed" });
    if (organizationId !== undefined) headers.set("X-Organization-Id", organizationId);
    const response = await app.request("/", { headers });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.listByUser).not.toHaveBeenCalled();
    expect(h.findMembership).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not treat a bearer credential's organization binding as a fallback preference", async () => {
    h.findActivePat.mockResolvedValue({
      id: "pat-bound",
      userId: "user_old",
      organizationId: "org-bound",
      scoped: true,
      readOnly: false,
    });
    h.listByUser.mockResolvedValue([
      { id: "other-member", userId: "user_old", organizationId: "other-org", role: "owner" },
    ]);
    h.findMembership.mockImplementation(async (org) =>
      org === "org-bound" ? null : { id: "other-member", role: "owner" },
    );
    const { app, handler } = appWithProtectedHandler();
    const response = await app.request("/", {
      headers: { Authorization: "Bearer opsh_pat_test-credential" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Invalid or expired access token",
      code: "INVALID_TOKEN",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(h.listByUser).not.toHaveBeenCalled();
  });

  it("carries bearer tenant and read-only restrictions into the application context", async () => {
    h.findActivePat.mockResolvedValue({
      id: "pat-bound",
      userId: "user_old",
      organizationId: "org-bound",
      scoped: true,
      readOnly: true,
    });
    h.findMembership.mockResolvedValue({ id: "bound-member", role: "owner" });
    const { app, handler } = appWithProtectedHandler();
    const response = await app.request("/", {
      headers: { Authorization: "Bearer opsh_pat_test-credential" },
    });
    expect(response.status).toBe(200);
    expect(handler.mock.calls[0]![0].get("ctx")).toMatchObject({
      organizationId: "org-bound",
      role: "restricted",
      principalKind: "pat",
      tokenScope: { tokenId: "pat-bound" },
      credential: { organizationId: "org-bound", readOnly: true },
    });
  });

  it.each(["GET", "POST"])("an administrator's organization-bound token cannot perform a whole-instance %s", async method => {
    h.findActivePat.mockResolvedValue({ id: "pat-bound-admin", userId: "user_old", organizationId: "org-bound", scoped: false, readOnly: false });
    h.findMembership.mockResolvedValue({ id: "member", role: "owner" });
    h.findInstanceRole.mockResolvedValue([{ role: "admin" }]);
    const app = new Hono();
    const handler = vi.fn(c => c.json({ ok: true }));
    app.use("*", authMiddleware, requireInstanceAdmin());
    app.on(method, "/", handler);
    const response = await app.request("/", { method, headers: { Authorization: "Bearer opsh_pat_test-credential" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "INSUFFICIENT_INSTANCE_ROLE" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps whole-instance access for an administrator's unbound, unscoped token", async () => {
    h.findActivePat.mockResolvedValue({ id: "pat-admin", userId: "user_old", organizationId: null, scoped: false, readOnly: false });
    h.listByUser.mockResolvedValue([{ id: "member", organizationId: "org_old", userId: "user_old", role: "owner" }]);
    h.findMembership.mockResolvedValue({ id: "member", role: "owner" });
    h.findInstanceRole.mockResolvedValue([{ role: "admin" }]);
    const app = new Hono();
    app.use("*", authMiddleware, requireInstanceAdmin());
    app.post("/", c => c.json({ ok: true }));
    expect((await app.request("/", { method: "POST", headers: { Authorization: "Bearer opsh_pat_test-credential" } })).status).toBe(200);
  });
});
