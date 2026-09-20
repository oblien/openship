import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  claim: null as null | {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
    inviterId: string;
    inviterIsInstanceAdmin: boolean;
    organization: { id: string; name: string };
  },
  existingUser: undefined as { id: string } | undefined,
}));

vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: {},
  isSaasDeployment: false,
}));
vi.mock("@repo/platform/engine/lib/invitation-claim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invitation-claim")>()),
  resolveInvitationClaim: vi.fn(async () => h.claim),
}));
vi.mock("@repo/db", () => ({
  repos: {
    user: { findByEmail: vi.fn(async () => h.existingUser) },
  },
}));

import { invitationPreview } from "@/modules/auth/auth.controller";
import { authRouteRateLimitPolicy } from "@/middleware/rate-limiter";

function app() {
  const instance = new Hono();
  instance.get("/:id", invitationPreview);
  return instance;
}

beforeEach(() => {
  h.claim = {
    id: "inv_1",
    email: "new@example.com",
    role: "member",
    expiresAt: new Date("2026-09-03T00:00:00.000Z"),
    inviterId: "usr_admin",
    inviterIsInstanceAdmin: true,
    organization: { id: "org_1", name: "Acme" },
  };
  h.existingUser = undefined;
});

describe("public invitation preview", () => {
  it("returns only the claim-page projection with no-store privacy headers", async () => {
    const response = await app().request("/inv_1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({
      data: {
        invitation: {
          id: "inv_1",
          email: "new@example.com",
          role: "member",
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
        organization: { id: "org_1", name: "Acme" },
        accountCreation: "invited",
      },
    });
  });

  it("hides account creation for existing users and unauthorized inviters", async () => {
    h.existingUser = { id: "usr_existing" };
    let response = await app().request("/inv_1");
    expect(
      ((await response.json()) as { data: { accountCreation: string } }).data.accountCreation,
    ).toBe("existing");

    h.existingUser = undefined;
    h.claim = { ...h.claim!, inviterIsInstanceAdmin: false };
    response = await app().request("/inv_1");
    expect(
      ((await response.json()) as { data: { accountCreation: string } }).data.accountCreation,
    ).toBe("disabled");
  });

  it("uses one generic 404 for every invalid invitation", async () => {
    h.claim = null;
    const response = await app().request("/not-a-real-token");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "This invitation is invalid or has expired.",
    });
  });

  it("is wired before the Better Auth catch-all and uses the one central tight limiter", () => {
    const source = readFileSync(
      new URL("../../../src/modules/auth/auth.routes.ts", import.meta.url),
      "utf8",
    );
    const preview = source.indexOf('"/invitation-preview/:id"');
    const catchAll = source.indexOf('authRoutes.on(["GET", "POST"], "/*"');
    expect(preview).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(catchAll);
    expect(source.slice(preview, preview + 160)).not.toContain("rateLimiterFor");
    expect(authRouteRateLimitPolicy("GET", "/api/auth/invitation-preview/inv_1")).toBe(
      "auth-tight",
    );
    expect(authRouteRateLimitPolicy("GET", "/api/auth/get-session")).toBe("default-anon");
    expect(authRouteRateLimitPolicy("POST", "/api/auth/sign-in/email")).toBe("auth-tight");
  });
});
