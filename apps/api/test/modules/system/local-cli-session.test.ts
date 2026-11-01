import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  env: { INTERNAL_TOKEN: "private-installation-credential", DEPLOY_MODE: "bare" },
  saas: false,
  founder: vi.fn(),
  organization: vi.fn(),
  mint: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/organization-lifecycle", () => ({
  get isSaasDeployment() {
    return h.saas;
  },
}));
vi.mock("@repo/db", () => ({
  repos: { user: { findFoundingAdmin: h.founder }, session: { purgeExpired: async () => 0 } },
}));
vi.mock("../../../src/lib/cloud-auth-proxy", () => ({ mintSession: h.mint }));
vi.mock("../../../src/middleware/active-organization", () => ({
  resolveActiveOrganizationId: h.organization,
}));
vi.mock("../../../src/middleware/loopback-peer", () => ({
  isLoopbackRequest: () => true,
  peerAddress: () => "127.0.0.1",
}));

import { internalAuth } from "../../../src/middleware/internal-auth";
import { createLocalCliSession } from "../../../src/modules/system/local-cli.controller";

function request(headers: Record<string, string> = {}, body: unknown = {}) {
  const app = new Hono();
  app.post("/cli-session", internalAuth, createLocalCliSession);
  return app.request("/cli-session", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.INTERNAL_TOKEN = "private-installation-credential";
  h.env.DEPLOY_MODE = "bare";
  h.saas = false;
  h.founder.mockResolvedValue({ id: "founder", role: "admin" });
  h.organization.mockResolvedValue("org-founder");
  h.mint.mockResolvedValue({ token: "a".repeat(64), expiresAt: new Date("2030-01-01") });
});

describe("local CLI administrator session", () => {
  it("uses the existing founder and normal session lifecycle, ignoring supplied identities", async () => {
    const response = await request(
      { "X-Internal-Token": h.env.INTERNAL_TOKEN },
      {
        userId: "victim",
        organizationId: "org-victim",
        role: "admin",
        ttlSeconds: 999999999,
      },
    );
    expect(response.status).toBe(200);
    expect(h.organization).toHaveBeenCalledWith("founder", null);
    expect(h.mint).toHaveBeenCalledExactlyOnceWith({
      purpose: "local-cli",
      userId: "founder",
      activeOrganizationId: "org-founder",
      userAgent: "openship-cli/local",
      ttlSeconds: 86400,
    });
    expect(await response.json()).toEqual({
      token: "a".repeat(64),
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it.each([undefined, "", "wrong", "opsh_pat_member"])(
    "refuses missing or incorrect installation credentials (%s)",
    async (token) => {
      const response = await request(token === undefined ? {} : { "X-Internal-Token": token });
      expect(response.status).toBe(401);
      expect(h.founder).not.toHaveBeenCalled();
      expect(h.mint).not.toHaveBeenCalled();
    },
  );

  it("does not accept a browser cookie or tenant PAT as installation authority", async () => {
    const response = await request({
      Authorization: "Bearer opsh_pat_admin",
      Cookie: "openship.session_token=session",
    });
    expect(response.status).toBe(401);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("does not use the desktop loopback fallback without a private credential", async () => {
    h.env.INTERNAL_TOKEN = "";
    h.env.DEPLOY_MODE = "desktop";
    expect((await request()).status).toBe(401);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("refuses SaaS even with its internal credential", async () => {
    h.saas = true;
    expect((await request({ "X-Internal-Token": h.env.INTERNAL_TOKEN })).status).toBe(404);
    expect(h.founder).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });

  it.each([
    { Origin: "https://ship.example.com" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "same-origin" },
  ])("refuses browser requests with headers %j", async (headers) => {
    expect((await request({ "X-Internal-Token": h.env.INTERNAL_TOKEN, ...headers })).status).toBe(
      403,
    );
    expect(h.mint).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: "member", role: "user" }])(
    "never creates or promotes an administrator (%j)",
    async (founder) => {
      h.founder.mockResolvedValue(founder);
      expect((await request({ "X-Internal-Token": h.env.INTERNAL_TOKEN })).status).toBe(409);
      expect(h.mint).not.toHaveBeenCalled();
    },
  );

  it("refuses a founder without a workspace", async () => {
    h.organization.mockResolvedValue(null);
    expect((await request({ "X-Internal-Token": h.env.INTERNAL_TOKEN })).status).toBe(409);
    expect(h.mint).not.toHaveBeenCalled();
  });
});
