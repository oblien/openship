import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { seedOwner, seedServer, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq, and, sql } from "@repo/db";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { permissionsRoutes } from "../../../src/modules/permissions/permissions.routes";
import { authRoutes } from "../../../src/modules/auth/auth.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/permissions", permissionsRoutes).route("/api/auth", authRoutes);
async function clients(owner: SeededOwner, organizationId = owner.orgId, limits: Partial<VerifiedIdentity> = {}) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user, sessionId: "permissions-test", ...limits }) } });
  return {
    native: (await ship.scope({ identity: "verified", organizationId })).permissions,
    remote: new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch }).permissions,
  };
}
async function addMember(owner: SeededOwner, actor: SeededOwner, role = "restricted") {
  await db.insert(schema.member).values({ id: `mem_${owner.userId}_${actor.userId}`, organizationId: owner.orgId, userId: actor.userId, role });
}
async function project(owner: SeededOwner, name: string) {
  const input = { organizationId: owner.orgId, name, slug: `${owner.userId}-${name}`, gitProvider: "upload" };
  const group = await repos.projectGroup.create(input);
  return repos.project.create({ ...input, groupId: group.id });
}

describe("permissions and invitations shared by native SDK and HTTP", () => {
  it("keeps the dashboard's legacy lifecycle URLs on the same authorized implementation", async () => {
    const owner = await seedOwner(), invitee = await seedOwner({ bound: false }), c = await clients(owner);
    const send = (actor: SeededOwner, route: string, body: unknown) => app.request(`/api/auth/organization/${route}`, {
      method: "POST", headers: { ...actor.auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const created = await send(owner, "invite-member", { email: `${invitee.userId}@test.local`, role: "restricted", delivery: "link" });
    expect(created.status).toBe(200);
    const invitation = await created.json() as { id: string };
    const resent = await send(owner, "invite-member", { email: `${invitee.userId}@test.local`, role: "owner", resend: true, delivery: "link" });
    expect(await resent.json()).toMatchObject({ id: invitation.id, role: "restricted" });
    const accepted = await send(invitee, "accept-invitation", { invitationId: invitation.id });
    expect(accepted.status).toBe(200);
    const result = await accepted.json() as { member: { id: string } };
    const changed = await send(owner, "update-member-role", { memberId: result.member.id, role: "member" });
    expect(changed.status).toBe(200);
    expect((await c.native.listMembers()).find(row => row.userId === invitee.userId)?.role).toBe("member");
    await send(owner, "remove-member", { memberIdOrEmail: result.member.id });
    expect(await repos.member.find(owner.orgId, invitee.userId)).toBeNull();
    const retained = await send(owner, "remove-member", { memberIdOrEmail: `${owner.userId}@test.local` });
    expect(retained.status).toBe(409);
  });
  it("round-trips individual and bulk grants, retaining source scopes and attribution", async () => {
    const owner = await seedOwner(), member = await seedOwner(), p = await project(owner, "grant"), c = await clients(owner);
    await addMember(owner, member);
    const created = await c.native.upsertGrant({ userId: member.userId, resourceType: "project", resourceId: p.id, permissions: ["read"] });
    expect((await c.remote.listGrants({ userId: member.userId }))[0]).toEqual(created);
    const grants = [{ resourceType: "github_repository", resourceId: "acme/app", permissions: ["read"] as "read"[], scope: { v: 1 as const, read: { paths: ["src/**"] } } }];
    await c.remote.replaceGrants({ userId: member.userId, grants });
    const list = await c.native.listGrants({ userId: member.userId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ...grants[0], grantedByUserId: owner.userId });
    await c.remote.deleteGrant(list[0]!.id);
    expect(await c.native.listGrants({ userId: member.userId })).toEqual([]);
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, owner.orgId));
    expect(events.map(event => event.eventType).sort()).toEqual(["grant.granted", "grant.replaced", "grant.revoked"]);
  });

  it("rejects cross-tenant grants and members through every mutation shape", async () => {
    const owner = await seedOwner(), member = await seedOwner(), other = await seedOwner(), foreign = await project(other, "foreign"), c = await clients(owner);
    await addMember(owner, member);
    for (const client of [c.native, c.remote]) {
      const grant = { resourceType: "project", resourceId: foreign.id, permissions: ["read"] as "read"[] };
      await expect(client.upsertGrant({ userId: member.userId, ...grant })).rejects.toMatchObject({ code: "RESOURCE_NOT_IN_ORG" });
      await expect(client.replaceGrants({ userId: member.userId, grants: [grant] })).rejects.toMatchObject({ code: "RESOURCE_NOT_IN_ORG" });
      await expect(client.inviteWithGrants({ email: `${other.userId}@test.local`, role: "restricted", grants: [grant], delivery: "link" })).rejects.toMatchObject({ code: "RESOURCE_NOT_IN_ORG" });
      await expect(client.removeMember(other.userId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await repos.invitation.listPendingByOrg(owner.orgId)).toEqual([]);
    expect(await repos.resourceGrant.listByMember(owner.orgId, member.userId)).toEqual([]);
  });

  it("filters catalogs and prevents members from administering permissions in either interface", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false }), server = await seedServer(owner.orgId), c = await clients(owner);
    await seedServer(owner.orgId, "hidden");
    await addMember(owner, member);
    await c.native.upsertGrant({ userId: member.userId, resourceType: "server", resourceId: server, permissions: ["read"] });
    const restricted = await clients(member, owner.orgId);
    for (const client of [restricted.native, restricted.remote]) {
      expect((await client.listResources({ type: "server" })).map(row => row.id)).toEqual([server]);
      expect((await client.listMembers()).map(row => row.userId)).toEqual([member.userId]);
      await expect(client.listGrants({ userId: member.userId })).rejects.toMatchObject({ code: "ORG_ADMIN_REQUIRED" });
      await expect(client.upsertGrant({ userId: member.userId, resourceType: "settings", resourceId: "*", permissions: ["admin"] })).rejects.toMatchObject({ code: "ORG_ADMIN_REQUIRED" });
      await expect(client.listResources({ type: "github_repository" })).rejects.toMatchObject({ code: "ORG_ADMIN_REQUIRED" });
    }
  });

  it("commits invitations, acceptance and source-scoped grants together without requiring a cookie session", async () => {
    const owner = await seedOwner(), invitee = await seedOwner({ bound: false }), c = await clients(owner), target = await clients(invitee);
    const grants = [{ resourceType: "github_repository", resourceId: "acme/invited", permissions: ["read"] as "read"[], scope: { v: 1 as const, read: { paths: ["docs/**"] } } }];
    const invitation = await c.native.inviteWithGrants({ email: `${invitee.userId}@test.local`, role: "restricted", grants, delivery: "link" });
    expect((await c.remote.listInvitations())[0]?.pendingGrants).toEqual(grants);
    const accepted = await target.remote.acceptInvitation(invitation.id);
    expect(accepted).toMatchObject({ organizationId: owner.orgId, member: { userId: invitee.userId, role: "restricted" }, materialized: 1 });
    const materialized = await c.native.listGrants({ userId: invitee.userId });
    expect(materialized[0]?.scope).toEqual(grants[0]!.scope);
    expect(await repos.invitationPendingGrant.listByInvitation(invitation.id)).toEqual([]);
    const scoped = await clients(invitee, owner.orgId);
    expect(await scoped.native.materializeInvitation(invitation.id)).toEqual({ materialized: 0 });
  });

  it("does not leave an invitation or partial replacement when persistence fails", async () => {
    const owner = await seedOwner(), invitee = await seedOwner(), member = await seedOwner(), c = await clients(owner), p = await project(owner, "atomic");
    await addMember(owner, member);
    const original = await c.native.upsertGrant({ userId: member.userId, resourceType: "project", resourceId: p.id, permissions: ["read"] });
    await db.execute(sql`ALTER TABLE resource_grant ADD CONSTRAINT sdk_grant_failure CHECK (resource_type <> 'audit') NOT VALID`);
    await db.execute(sql`ALTER TABLE invitation_pending_grant ADD CONSTRAINT sdk_invitation_failure CHECK (resource_type <> 'audit') NOT VALID`);
    try {
      const grants = [{ resourceType: "audit", resourceId: "*", permissions: ["read"] as "read"[] }];
      await expect(c.native.replaceGrants({ userId: member.userId, grants })).rejects.toBeDefined();
      expect(await c.remote.listGrants({ userId: member.userId })).toEqual([original]);
      await expect(c.native.inviteWithGrants({ email: `${invitee.userId}@test.local`, grants, delivery: "link" })).rejects.toBeDefined();
      expect(await c.remote.listInvitations()).toEqual([]);
    } finally {
      await db.execute(sql`ALTER TABLE resource_grant DROP CONSTRAINT sdk_grant_failure`);
      await db.execute(sql`ALTER TABLE invitation_pending_grant DROP CONSTRAINT sdk_invitation_failure`);
    }
  });

  it("honors inviter revocation before a saved invitation can grant membership", async () => {
    const owner = await seedOwner(), invitee = await seedOwner(), c = await clients(owner), target = await clients(invitee);
    const invitation = await c.remote.inviteWithGrants({ email: `${invitee.userId}@test.local`, delivery: "link" });
    const token = (await repos.personalAccessToken.listByUser(owner.userId))[0]!;
    await repos.personalAccessToken.revoke(token.id, owner.userId);
    await expect(target.native.acceptInvitation(invitation.id)).rejects.toMatchObject({ statusCode: 401 });
    expect(await repos.member.find(owner.orgId, invitee.userId)).toBeNull();
    expect((await repos.invitation.findById(invitation.id))?.status).toBe("pending");
    // Rejection is still possible after inviter revocation.
    expect(await target.native.rejectInvitation(invitation.id)).toEqual({ rejected: true });
  });

  it("serializes HTTP cancellation with native acceptance and protects the final owner", async () => {
    const owner = await seedOwner(), invitee = await seedOwner(), c = await clients(owner), target = await clients(invitee);
    const invitation = await c.native.inviteWithGrants({ email: `${invitee.userId}@test.local`, delivery: "link" });
    const results = await Promise.allSettled([target.native.acceptInvitation(invitation.id), c.remote.cancelInvitation(invitation.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const stored = (await repos.invitation.findById(invitation.id))!;
    expect(!!await repos.member.find(owner.orgId, invitee.userId)).toBe(stored.status === "accepted");
    for (const client of [c.native, c.remote]) {
      await expect(client.removeMember(owner.userId)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(client.setMemberRole(owner.userId, { role: "member" })).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("cleans grants on member removal and revalidates the actor on later calls", async () => {
    const owner = await seedOwner(), member = await seedOwner(), c = await clients(owner);
    await addMember(owner, member, "admin");
    await c.native.upsertGrant({ userId: member.userId, resourceType: "settings", resourceId: "*", permissions: ["write"] });
    const actor = await clients(member, owner.orgId);
    await c.remote.removeMember(member.userId);
    expect(await repos.resourceGrant.listByMember(owner.orgId, member.userId)).toEqual([]);
    await expect(actor.native.listInvitations()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
