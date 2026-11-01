import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, eq, ilike, schema, repos } from "@repo/db";
import { createInvitedUserWithCredential } from "@repo/platform/engine/lib/invitation-signup";

const invitationId = "inv_atomic_signup";
const competingInvitationId = "inv_atomic_signup_competing";
const inviterId = "usr_invitation_admin";
const organizationId = "org_invitation_target";
const invitedEmail = "new.user@example.com";

async function cleanFixture() {
  await db.delete(schema.personalAccessToken).where(eq(schema.personalAccessToken.userId, inviterId));
  await db.delete(schema.invitation).where(eq(schema.invitation.id, invitationId));
  await db.delete(schema.invitation).where(eq(schema.invitation.id, competingInvitationId));

  const invitedUsers = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(ilike(schema.user.email, invitedEmail));
  for (const row of invitedUsers) {
    await db.delete(schema.user).where(eq(schema.user.id, row.id));
    await db.delete(schema.organization).where(eq(schema.organization.id, `org_${row.id}`));
  }

  await db.delete(schema.organization).where(eq(schema.organization.id, organizationId));
  await db.delete(schema.user).where(eq(schema.user.id, inviterId));
}

async function seedClaim(
  options: {
    status?: string;
    expiresAt?: Date;
    inviterRole?: string;
  } = {},
) {
  await db.insert(schema.user).values({
    id: inviterId,
    name: "Instance Admin",
    email: "instance.admin@example.com",
    emailVerified: true,
    role: options.inviterRole ?? "admin",
  });
  await db.insert(schema.organization).values({
    id: organizationId,
    name: "Target Team",
    slug: "invitation-target-team",
  });
  await db.insert(schema.invitation).values({
    id: invitationId,
    organizationId,
    email: " New.User@Example.COM ",
    role: "member",
    status: options.status ?? "pending",
    inviterId,
    expiresAt: options.expiresAt ?? new Date("2030-01-02T00:00:00.000Z"),
  });
}

beforeEach(cleanFixture);
afterEach(cleanFixture);

describe("createInvitedUserWithCredential", () => {
  it("refuses account creation after the invitation's saved credential is revoked", async () => {
    await seedClaim();
    await db.insert(schema.member).values({ id: "mem_invitation_admin", organizationId, userId: inviterId, role: "owner" });
    const token = await repos.personalAccessToken.create({
      userId: inviterId, organizationId, name: "inviter", tokenPrefix: "test", tokenHash: "invitation-signup-test",
      readOnly: false, scoped: false, expiresAt: null,
    });
    await db.update(schema.invitation).set({ executionAuthority: {
      version: 1, userId: inviterId, organizationId, token: { id: token.id, kind: "pat", scoped: false }, restrictions: null,
    } }).where(eq(schema.invitation.id, invitationId));
    await repos.personalAccessToken.revoke(token.id, inviterId);
    expect(await createInvitedUserWithCredential({ invitationId, name: "Revoked", passwordHash: "hash" })).toEqual({ status: "invalid" });
    expect(await db.select().from(schema.user).where(ilike(schema.user.email, invitedEmail))).toEqual([]);
  });
  it("locks the claim and commits the identity invariant with its credential", async () => {
    await seedClaim();

    await expect(
      createInvitedUserWithCredential({
        invitationId,
        name: "Invited User",
        passwordHash: "hashed-password",
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "created", email: invitedEmail });

    const [created] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, invitedEmail));
    expect(created).toMatchObject({
      name: "Invited User",
      email: invitedEmail,
      emailVerified: true,
      role: "user",
    });

    const [credential] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, created.id));
    expect(credential).toMatchObject({
      providerId: "credential",
      accountId: created.id,
      password: "hashed-password",
    });

    const personalOrganizationId = `org_${created.id}`;
    const [personalOrganization] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, personalOrganizationId));
    const [personalMembership] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, created.id));
    expect(personalOrganization).toBeTruthy();
    expect(personalMembership).toMatchObject({
      organizationId: personalOrganizationId,
      role: "owner",
    });
  });

  it.each([
    ["canceled", new Date("2030-01-02T00:00:00.000Z"), "admin"],
    ["rejected", new Date("2030-01-02T00:00:00.000Z"), "admin"],
    ["pending", new Date("2029-12-31T23:59:59.000Z"), "admin"],
    ["pending", new Date("2030-01-02T00:00:00.000Z"), "user"],
  ])(
    "fails closed for status=%s expiry=%s inviterRole=%s",
    async (status, expiresAt, inviterRole) => {
      await seedClaim({ status, expiresAt, inviterRole });

      await expect(
        createInvitedUserWithCredential({
          invitationId,
          name: "Should Not Exist",
          passwordHash: "hashed-password",
          now: new Date("2030-01-01T00:00:00.000Z"),
        }),
      ).resolves.toEqual({ status: "invalid" });

      const [created] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, invitedEmail));
      expect(created).toBeUndefined();
    },
  );

  it("treats an existing mailbox case-insensitively and never changes it", async () => {
    await seedClaim();
    await db.insert(schema.user).values({
      id: "usr_existing_invitee",
      name: "Existing",
      email: "NEW.USER@example.com",
      emailVerified: true,
    });

    await expect(
      createInvitedUserWithCredential({
        invitationId,
        name: "Replacement",
        passwordHash: "replacement-hash",
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "existing" });

    const [existing] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, "usr_existing_invitee"));
    expect(existing.name).toBe("Existing");
    await db.delete(schema.user).where(eq(schema.user.id, "usr_existing_invitee"));
  });

  it("converges concurrent claims for the same mailbox on one account", async () => {
    await seedClaim();
    await db.insert(schema.invitation).values({
      id: competingInvitationId,
      organizationId,
      email: invitedEmail,
      role: "member",
      status: "pending",
      inviterId,
      expiresAt: new Date("2030-01-02T00:00:00.000Z"),
    });

    const results = await Promise.all([
      createInvitedUserWithCredential({
        invitationId,
        name: "First claimant",
        passwordHash: "first-hash",
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
      createInvitedUserWithCredential({
        invitationId: competingInvitationId,
        name: "Second claimant",
        passwordHash: "second-hash",
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "existing"]);
    const users = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, invitedEmail));
    expect(users).toHaveLength(1);
  });

  it("rejects malformed ids without touching the database", async () => {
    await expect(
      createInvitedUserWithCredential({
        invitationId: "../invite",
        name: "Invalid",
        passwordHash: "hashed-password",
      }),
    ).resolves.toEqual({ status: "invalid" });
  });
});
