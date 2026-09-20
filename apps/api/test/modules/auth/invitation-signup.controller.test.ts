import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  isSaas: false,
  claim: {
    id: "inv_1",
    email: "bound@example.com",
    role: "member",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    inviterId: "usr_admin",
    inviterIsInstanceAdmin: true,
    organization: { id: "org_1", name: "Acme" },
  } as null | {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
    inviterId: string;
    inviterIsInstanceAdmin: boolean;
    organization: { id: string; name: string };
  },
  existingUser: undefined as { id: string } | undefined,
  createResult: { status: "created", email: "bound@example.com" } as
    | { status: "created"; email: string }
    | { status: "invalid" }
    | { status: "existing" },
  hashPassword: vi.fn(async () => "hashed-password"),
  createInvitedUser: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/auth", () => ({
  get isSaasDeployment() {
    return h.isSaas;
  },
}));
vi.mock("@repo/platform/engine/lib/invitation-claim", () => ({
  resolveInvitationClaim: vi.fn(async () => h.claim),
}));
vi.mock("@repo/db", () => ({
  repos: { user: { findByEmail: vi.fn(async () => h.existingUser) } },
}));
vi.mock("better-auth/crypto", () => ({ hashPassword: h.hashPassword }));
vi.mock("@repo/platform/engine/lib/invitation-signup", () => ({
  createInvitedUserWithCredential: h.createInvitedUser,
}));

import {
  invitationSignupBodyLimit,
  inviteSignup,
} from "@/modules/auth/invitation-signup.controller";

function app() {
  const instance = new Hono();
  instance.post("/", invitationSignupBodyLimit, inviteSignup);
  return instance;
}

function request(body: Record<string, unknown>) {
  const encoded = JSON.stringify(body);
  return app().request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(encoded).byteLength),
    },
    body: encoded,
  });
}

beforeEach(() => {
  h.isSaas = false;
  h.claim = {
    id: "inv_1",
    email: "bound@example.com",
    role: "member",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    inviterId: "usr_admin",
    inviterIsInstanceAdmin: true,
    organization: { id: "org_1", name: "Acme" },
  };
  h.existingUser = undefined;
  h.createResult = { status: "created", email: "bound@example.com" };
  h.hashPassword.mockClear();
  h.hashPassword.mockResolvedValue("hashed-password");
  h.createInvitedUser.mockReset();
  h.createInvitedUser.mockImplementation(async () => h.createResult);
});

describe("inviteSignup controller", () => {
  it("binds account creation to the invitation email and never accepts an email input", async () => {
    const response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
      email: "attacker@example.com",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, email: "bound@example.com" });
    expect(h.createInvitedUser).toHaveBeenCalledWith({
      invitationId: "inv_1",
      name: "New User",
      passwordHash: "hashed-password",
    });
    expect(h.createInvitedUser.mock.calls[0][0]).not.toHaveProperty("email");
  });

  it("rejects invalid and non-admin claims before hashing", async () => {
    h.claim = null;
    let response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
    });
    expect(response.status).toBe(403);
    expect(h.hashPassword).not.toHaveBeenCalled();

    h.claim = {
      id: "inv_1",
      email: "bound@example.com",
      role: "member",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      inviterId: "usr_member",
      inviterIsInstanceAdmin: false,
      organization: { id: "org_1", name: "Acme" },
    };
    response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
    });
    expect(response.status).toBe(403);
    expect(h.hashPassword).not.toHaveBeenCalled();
  });

  it("maps preflight and transaction races to a stable existing-account response", async () => {
    h.existingUser = { id: "usr_existing" };
    let response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
    });
    expect(response.status).toBe(409);
    expect(h.hashPassword).not.toHaveBeenCalled();

    h.existingUser = undefined;
    h.createResult = { status: "existing" };
    response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
    });
    expect(response.status).toBe(409);
  });

  it("fails closed when cancellation wins after the preflight", async () => {
    h.createResult = { status: "invalid" };
    const response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This invitation is invalid or has expired.",
    });
  });

  it("is unavailable on SaaS even if it is accidentally remounted", async () => {
    h.isSaas = true;
    const response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "secret-password",
    });
    expect(response.status).toBe(404);
    expect(h.createInvitedUser).not.toHaveBeenCalled();
  });

  it("rejects oversized unauthenticated bodies before parsing or hashing", async () => {
    const response = await request({
      invitationId: "inv_1",
      name: "New User",
      password: "x".repeat(9_000),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Invitation signup request is too large.",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(h.hashPassword).not.toHaveBeenCalled();
  });

  it("validates bounded name and password inputs", async () => {
    expect(
      (await request({ invitationId: "inv_1", name: "", password: "secret-password" })).status,
    ).toBe(400);
    expect((await request({ invitationId: "inv_1", name: "User", password: "short" })).status).toBe(
      400,
    );
    expect(h.hashPassword).not.toHaveBeenCalled();
  });
});

describe("inviteSignup route hardening", () => {
  const routes = readFileSync(
    new URL("../../../src/modules/system/system.routes.ts", import.meta.url),
    "utf8",
  );
  const start = routes.indexOf('"/invite-signup"');
  const chunk = routes.slice(start, routes.indexOf("\n);", start) + 3);

  it("mounts exactly one tight limiter and the fixed body cap", () => {
    expect(start).toBeGreaterThan(-1);
    expect(chunk).toContain('rateLimit: "auth-tight"');
    expect(chunk).toContain("invitationSignupBodyLimit");
    expect(chunk).not.toContain("rateLimiterFor");
  });

  it("keeps signup logic out of the unrelated setup controller", () => {
    const setup = readFileSync(
      new URL("../../../src/modules/system/setup.controller.ts", import.meta.url),
      "utf8",
    );
    expect(setup).not.toContain("function inviteSignup");
    expect(setup).not.toContain("provisionUserWithCredential");
  });
});
