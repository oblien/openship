import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invitation: undefined as
    | {
        id: string;
        email: string;
        role: string;
        status: string;
        expiresAt: Date;
        inviterId: string;
        organizationId: string;
      }
    | undefined,
  organization: undefined as { id: string; name: string } | null | undefined,
  inviter: undefined as { id: string; role: string } | undefined,
}));

vi.mock("@repo/db", () => ({
  repos: {
    invitation: { findById: vi.fn(async () => h.invitation) },
    organization: { findById: vi.fn(async () => h.organization) },
    user: { findById: vi.fn(async () => h.inviter) },
  },
}));

import { invitationAccountCreationMode, resolveInvitationClaim } from "@repo/platform/engine/lib/invitation-claim";

const now = new Date("2026-09-01T12:00:00.000Z");

beforeEach(() => {
  h.invitation = {
    id: "inv_1",
    email: "  New.User@Example.COM ",
    role: "member",
    status: "pending",
    expiresAt: new Date("2026-09-02T12:00:00.000Z"),
    inviterId: "usr_admin",
    organizationId: "org_team",
  };
  h.organization = { id: "org_team", name: "Acme" };
  h.inviter = { id: "usr_admin", role: "admin" };
});

describe("resolveInvitationClaim", () => {
  it("returns the minimal claim and normalizes its bound email", async () => {
    await expect(resolveInvitationClaim("inv_1", now)).resolves.toEqual({
      id: "inv_1",
      email: "new.user@example.com",
      role: "member",
      expiresAt: new Date("2026-09-02T12:00:00.000Z"),
      inviterId: "usr_admin",
      inviterIsInstanceAdmin: true,
      organization: { id: "org_team", name: "Acme" },
    });
  });

  it.each(["accepted", "rejected", "canceled", "expired"])(
    "fails closed for %s invitations",
    async (status) => {
      h.invitation = { ...h.invitation!, status };
      await expect(resolveInvitationClaim("inv_1", now)).resolves.toBeNull();
    },
  );

  it("checks expiry even when Better Auth left status pending", async () => {
    h.invitation = {
      ...h.invitation!,
      expiresAt: new Date("2026-09-01T11:59:59.000Z"),
    };
    await expect(resolveInvitationClaim("inv_1", now)).resolves.toBeNull();
  });

  it("fails closed if a referenced organization or inviter disappeared", async () => {
    h.organization = null;
    await expect(resolveInvitationClaim("inv_1", now)).resolves.toBeNull();

    h.organization = { id: "org_team", name: "Acme" };
    h.inviter = undefined;
    await expect(resolveInvitationClaim("inv_1", now)).resolves.toBeNull();
  });

  it("does not treat an organization owner as an instance administrator", async () => {
    h.inviter = { id: "usr_admin", role: "user" };
    await expect(resolveInvitationClaim("inv_1", now)).resolves.toMatchObject({
      inviterIsInstanceAdmin: false,
    });
  });

  it.each(["", "../inv_1", "inv/1", "x".repeat(201)])(
    "rejects malformed token %j before lookup",
    async (token) => {
      await expect(resolveInvitationClaim(token, now)).resolves.toBeNull();
    },
  );
});

describe("invitationAccountCreationMode", () => {
  it.each([
    [{ accountExists: true, isSaas: false, inviterIsInstanceAdmin: false }, "existing"],
    [{ accountExists: true, isSaas: true, inviterIsInstanceAdmin: false }, "existing"],
    [{ accountExists: false, isSaas: true, inviterIsInstanceAdmin: false }, "public"],
    [{ accountExists: false, isSaas: false, inviterIsInstanceAdmin: true }, "invited"],
    [{ accountExists: false, isSaas: false, inviterIsInstanceAdmin: false }, "disabled"],
  ] as const)("resolves %o as %s", (input, expected) => {
    expect(invitationAccountCreationMode(input)).toBe(expected);
  });
});
