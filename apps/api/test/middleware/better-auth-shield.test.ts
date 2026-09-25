import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  session: { user: { id: "caller" }, session: { activeOrganizationId: "personal" as string | null } },
  sessionRead: vi.fn(), memberRead: vi.fn(), slugRead: vi.fn(), downstream: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: h.sessionRead } } }));
vi.mock("@repo/db", () => ({ repos: { member: { find: h.memberRead }, organization: { findBySlug: h.slugRead } } }));
import { betterAuthShield } from "@/middleware/better-auth-shield";

const app = new Hono();
app.use("*", betterAuthShield);
app.all("*", c => {
  h.downstream();
  return c.json({ id: "team", members: [{ userId: "caller" }, { userId: "victim", email: "private@example.test" }], invitations: [{ id: "private-invite" }] });
});
const get = (path: string) => app.request(`/api/auth/organization/${path}`);

beforeEach(() => {
  vi.resetAllMocks();
  h.session.session.activeOrganizationId = "personal";
  h.sessionRead.mockResolvedValue(h.session);
  h.memberRead.mockImplementation(async (org: string) => ({ role: org === "personal" ? "owner" : "restricted" }));
  h.slugRead.mockImplementation(async (slug: string) => slug === "team-slug" ? { id: "team" } : null);
});

describe("Better Auth target-organization authorization", () => {
  it.each(["list-members", "get-active-member-role"])("denies restricted %s even with an owned active org and conflicting organizationId", async path => {
    const res = await get(`${path}?organizationSlug=team-slug&organizationId=personal&userId=victim`);
    expect(res.status).toBe(403);
    expect(h.memberRead).toHaveBeenCalledWith("team", "caller");
    expect(h.downstream).not.toHaveBeenCalled();
  });
  it.each(["personal", null])("filters a slug-targeted full organization with active org %s", async active => {
    h.session.session.activeOrganizationId = active;
    const res = await get("get-full-organization?organizationSlug=team-slug");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "team", members: [{ userId: "caller" }], invitations: [] });
  });
  it("does not fall back to an owned org when a slug is missing", async () => {
    expect((await get("get-full-organization?organizationSlug=missing")).status).toBe(403);
    expect(h.downstream).not.toHaveBeenCalled();
  });
  it.each(["session", "slug", "membership"])("fails closed on %s lookup failure", async lookup => {
    ({ session: h.sessionRead, slug: h.slugRead, membership: h.memberRead })[lookup]!.mockRejectedValue(new Error("database unavailable"));
    expect((await get("get-full-organization?organizationSlug=team-slug")).status).toBe(503);
    expect(h.downstream).not.toHaveBeenCalled();
  });
  it("does not use a POST query to authorize a different organization in the body", async () => {
    const res = await app.request("/api/auth/organization/invite-member?organizationId=personal", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: "team" }),
    });
    expect(res.status).toBe(403);
    expect(h.downstream).not.toHaveBeenCalled();
  });
  it("retains administrator reads", async () => {
    h.memberRead.mockResolvedValue({ role: "admin" });
    expect((await get("get-full-organization?organizationSlug=team-slug")).status).toBe(200);
    expect(h.downstream).toHaveBeenCalledOnce();
  });
  it("preserves an empty current org and unsetting the active organization", async () => {
    h.session.session.activeOrganizationId = null;
    expect(await (await get("get-full-organization")).json()).toBeNull();
    const res = await app.request("/api/auth/organization/set-active", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: null }),
    });
    expect(res.status).toBe(200);
  });
});
