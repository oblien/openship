import { AppError, ConflictError, NotFoundError, generateId, type Permission, type ResourceType } from "@repo/core";
import { db, repos, schema, eq, and, sql, type DatabaseTransaction } from "@repo/db";
import { createResourceGrantRepo, createInvitationPendingGrantRepo } from "@repo/db/repos";
import type { InviteWithGrantsInput, PermissionGrantInput, WorkspaceList } from "@repo/contracts";
import type { ContextRole, ExecutionContext } from "../../../context";
import { organizationOptions, deliverOrganizationInvitation, INVITE_RATE_LIMIT_PER_HOUR, INVITE_RATE_LIMIT_WINDOW_MS } from "../../lib/organization-lifecycle";
import { smtpEnabled } from "../../lib/mail";
import { withInvitationLifecycleLock } from "../../lib/invitation-lifecycle-lock";
import { captureExecutionAuthority, resolveExecutionAuthority } from "../../lib/execution-authority";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { authorization } from "../../lib/authorization";
import { changeMembership } from "../../lib/member-lifecycle";

/** Membership discovery, including empty workspaces. Never expose another
 * tenant through a bound credential or an explicitly fixed execution scope. */
export async function listWorkspaces(ctx: ExecutionContext): Promise<WorkspaceList> {
  const boundOrganizationId = ctx.credential?.organizationId ?? (ctx.tokenScope ? ctx.organizationId : null);
  const fixedOrganizationId = boundOrganizationId ?? (ctx.scopeMode === "fixed" ? ctx.organizationId : null);
  const memberships = fixedOrganizationId
    ? [await repos.member.find(fixedOrganizationId, ctx.userId)].filter(member => member !== null)
    : await repos.member.listByUser(ctx.userId);
  const organizations = await repos.organization.findManyById(memberships.map(member => member.organizationId));
  const roles = new Map(memberships.map(member => [member.organizationId, member.role]));
  return {
    currentOrganizationId: ctx.organizationId,
    boundOrganizationId,
    canSwitchOrganization: boundOrganizationId === null,
    readOnly: ctx.credential?.readOnly ?? false,
    workspaces: organizations
      .map(org => ({
        organizationId: org.id, name: org.name, slug: org.slug,
        isTeam: org.isTeam === true,
        role: ctx.tokenScope ? "restricted" as const : roles.get(org.id) as ContextRole,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.organizationId.localeCompare(b.organizationId)),
  };
}

export function assertOrgAdmin(ctx: ExecutionContext): void {
  if (ctx.tokenScope || !["owner", "admin"].includes(ctx.role))
    throw new AppError("An organization administrator is required", 403, "ORG_ADMIN_REQUIRED");
}

export function assertAccountMutation(ctx: ExecutionContext): void {
  if (ctx.tokenScope || ctx.credential?.organizationId)
    throw new AppError("A tenant-bound credential cannot change account memberships", 403, "ACCOUNT_LIFECYCLE_DENIED");
}

function providerError(error: unknown): never {
  if (error && typeof error === "object" && "statusCode" in error && "body" in error) {
    const value = error as { statusCode: number; body: { message?: string; code?: string } };
    throw new AppError(value.body.message ?? "Organization operation failed", value.statusCode, value.body.code ?? "ORGANIZATION_OPERATION_FAILED");
  }
  throw error;
}

/** Mutating member/grant paths lock the org and refresh the actor inside the transaction. */
export async function lockOrganization(tx: DatabaseTransaction, ctx: ExecutionContext, admin = true) {
  const [organization] = await tx.select().from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)).for("update");
  const [member] = await tx.select().from(schema.member).where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId))).for("update");
  if (!organization || !member) throw new NotFoundError("Organization", ctx.organizationId);
  const current = { ...ctx, role: member.role as ContextRole, membershipId: member.id };
  if (admin) assertOrgAdmin(current);
  return { organization, member, context: current };
}

export async function createInvitationWithGrants(ctx: ExecutionContext, body: InviteWithGrantsInput) {
  assertOrgAdmin(ctx);
  const email = body.email.trim().toLowerCase(), role = body.role ?? "member";
  if (role === "owner" && ctx.role !== "owner")
    throw new AppError("Only an owner may invite another owner", 403, "ORG_OWNER_REQUIRED");
  const user = (await repos.user.findById(ctx.userId))!;
  const authority = await captureExecutionAuthority(ctx);
  const grants = body.grants ?? [];
  const org = await repos.organization.findById(ctx.organizationId);
  if (!org || !user) throw new NotFoundError("Organization", ctx.organizationId);
  await organizationOptions.organizationHooks.beforeCreateInvitation({
    invitation: { organizationId: ctx.organizationId, email, role, inviterId: ctx.userId }, inviter: user,
    organization: { ...org, slug: org.slug ?? org.id },
  }).catch(providerError);
  const result = await db.transaction(async tx => {
    const { organization, member } = await lockOrganization(tx, ctx);
    // Serialize the retained per-inviter rate limit across organization scopes.
    await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, ctx.userId)).for("update");
    const [existingUser] = await tx.select().from(schema.user).where(eq(schema.user.email, email));
    const existingMember = existingUser ? await tx.select().from(schema.member).where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, existingUser.id))) : [];
    if (existingMember.length)
      throw new ConflictError("The user is already a member of this organization");
    const pending = await tx.select().from(schema.invitation).where(and(eq(schema.invitation.organizationId, ctx.organizationId), eq(schema.invitation.status, "pending")));
    if (pending.some(invitation => invitation.email.toLowerCase() === email && invitation.expiresAt.getTime() > Date.now()))
      throw new ConflictError("The user is already invited to this organization");
    if (pending.filter(invitation => invitation.expiresAt.getTime() > Date.now()).length >= 100)
      throw new AppError("The organization invitation limit has been reached", 403, "INVITATION_LIMIT_REACHED");
    if (role === "owner" && member.role !== "owner") throw new AppError("Only an owner may invite another owner", 403, "ORG_OWNER_REQUIRED");
    const recent = await tx.select({ count: sql<number>`count(*)` }).from(schema.invitation).where(and(eq(schema.invitation.inviterId, ctx.userId), sql`${schema.invitation.createdAt} >= ${new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS)}`));
    if (Number(recent[0]?.count ?? 0) >= INVITE_RATE_LIMIT_PER_HOUR)
      throw new AppError("Invitation rate limit reached", 429, "INVITATION_RATE_LIMIT");
    const [invitation] = await tx.insert(schema.invitation).values({
      id: generateId("inv"), organizationId: ctx.organizationId, email, role, inviterId: ctx.userId,
      expiresAt: new Date(Date.now() + organizationOptions.invitationExpiresIn * 1000), executionAuthority: authority,
    }).returning();
    const pendingGrants = createInvitationPendingGrantRepo(tx);
    for (const grant of grants) await pendingGrants.create({ ...grant, invitationId: invitation!.id, resourceType: grant.resourceType as ResourceType });
    return { organization: { ...organization, slug: organization.slug ?? organization.id }, member, invitation: { ...invitation!, status: "pending" as const } };
  });
  // Delivery happens after the invitation AND all its grants commit.
  await organizationOptions.organizationHooks.afterCreateInvitation({ ...result, inviter: user });
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "invitation.sent", resourceType: "resource_grant", resourceId: result.invitation.id,
    after: { email, role, pendingGrantCount: grants.length },
  });
  if (body.delivery !== "link" && smtpEnabled) await deliverOrganizationInvitation({
    id: result.invitation.id, role, email, organization: result.organization,
    inviter: { ...result.member, user }, invitation: result.invitation,
  }).catch(providerError);
  return { id: result.invitation.id, email, role, pendingGrantCount: grants.length };
}

type StoredInvitation = typeof schema.invitation.$inferSelect;
type GrantPlan = { pendingIds: string[]; grants: PermissionGrantInput[]; inviter: ExecutionContext | null };

async function prepareGrantPlan(invitation: StoredInvitation): Promise<GrantPlan> {
  const pending = await repos.invitationPendingGrant.listByInvitation(invitation.id);
  if (!pending.length) return { pendingIds: [], grants: [], inviter: null };
  const inviter = await resolveInviter(invitation);
  const { normalizeGrants } = await import("./permissions.service");
  return { pendingIds: pending.map(grant => grant.id).sort(), grants: await normalizeGrants(inviter, pending), inviter };
}

export async function resolveInviter(invitation: StoredInvitation): Promise<ExecutionContext> {
  const user = await repos.user.findById(invitation.inviterId);
  if (!user) throw new AppError("The inviter no longer has access", 403, "INVITATION_AUTHORITY_REVOKED");
  // Legacy invites came from the authentication provider; their stored inviter
  // must still be an administrator. New delegates also revalidate their token.
  const inviter = invitation.executionAuthority
    ? await resolveExecutionAuthority(invitation.executionAuthority, `invitation:${invitation.id}`)
    : await authorization.resolveScope({ user, sessionId: `invitation:${invitation.id}`, sessionKind: "native" }, invitation.organizationId);
  if (inviter.userId !== invitation.inviterId || inviter.organizationId !== invitation.organizationId)
    throw new AppError("The invitation authority is invalid", 403, "INVITATION_AUTHORITY_REVOKED");
  assertOrgAdmin(inviter);
  return inviter;
}

/** Recheck the persisted actor after acquiring row locks, without leaving the transaction. */
export async function checkInviter(tx: DatabaseTransaction, invitation: StoredInvitation, inviter: ExecutionContext) {
  const [member] = await tx.select().from(schema.member).where(and(eq(schema.member.organizationId, invitation.organizationId), eq(schema.member.userId, invitation.inviterId))).for("update");
  if (!member || !["owner", "admin"].includes(member.role) || (invitation.role === "owner" && member.role !== "owner"))
    throw new AppError("The inviter no longer has authority", 403, "INVITATION_AUTHORITY_REVOKED");
  const authority = invitation.executionAuthority;
  if (authority?.restrictions?.expiresAt != null && authority.restrictions.expiresAt <= Date.now())
    throw new AppError("The invitation authority expired", 403, "INVITATION_AUTHORITY_REVOKED");
  if (authority?.token) {
    const [token] = await tx.select().from(schema.personalAccessToken).where(eq(schema.personalAccessToken.id, authority.token.id)).for("update");
    if (!token || token.userId !== invitation.inviterId || token.revokedAt || token.readOnly || token.scoped ||
        (token.organizationId && token.organizationId !== invitation.organizationId) || (token.expiresAt && token.expiresAt.getTime() <= Date.now()))
      throw new AppError("The invitation authority was revoked", 403, "INVITATION_AUTHORITY_REVOKED");
  }
  if (inviter.credential?.readOnly || inviter.tokenScope) throw new AppError("The invitation authority was revoked", 403, "INVITATION_AUTHORITY_REVOKED");
}

async function materializeInTransaction(tx: DatabaseTransaction, invitation: StoredInvitation, userId: string, plan: GrantPlan): Promise<number> {
  const pendingRepo = createInvitationPendingGrantRepo(tx);
  const pending = await pendingRepo.listByInvitation(invitation.id);
  if (!pending.length) return 0;
  if (JSON.stringify(pending.map(grant => grant.id).sort()) !== JSON.stringify(plan.pendingIds) || !plan.inviter)
    throw new ConflictError("The invitation grants changed; retry the operation");
  await checkInviter(tx, invitation, plan.inviter);
  const member = await tx.select().from(schema.member).where(and(eq(schema.member.organizationId, invitation.organizationId), eq(schema.member.userId, userId))).for("update");
  if (!member.length) throw new ConflictError("Accept the invitation before applying its grants");
  const resourceGrants = createResourceGrantRepo(tx);
  for (const grant of plan.grants) await resourceGrants.upsert({
    ...grant, organizationId: invitation.organizationId, userId, resourceType: grant.resourceType as ResourceType,
    grantedByUserId: invitation.inviterId,
  });
  await pendingRepo.deleteByInvitation(invitation.id);
  return plan.grants.length;
}

/** Used by both the authentication-provider acceptance hook and native claims. */
export async function materializeForUser(invitationId: string, userId: string): Promise<number> {
  const before = await repos.invitation.findById(invitationId);
  if (!before) return 0;
  const recipient = await repos.user.findById(userId);
  if (!recipient || recipient.email.toLowerCase() !== before.email.toLowerCase()) throw new NotFoundError("Invitation", invitationId);
  const plan = await prepareGrantPlan(before);
  return db.transaction(async tx => {
    await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, before.organizationId)).for("update");
    const [invitation] = await tx.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId)).for("update");
    if (!invitation) return 0;
    if (invitation.status !== "accepted" || invitation.expiresAt.getTime() <= Date.now())
      throw new ConflictError("The invitation must be accepted and unexpired");
    const [user] = await tx.select().from(schema.user).where(eq(schema.user.id, userId));
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) throw new NotFoundError("Invitation", invitationId);
    return materializeInTransaction(tx, invitation, userId, plan);
  });
}

async function claim(ctx: ExecutionContext, id: string, status: "accepted" | "rejected") {
  assertAccountMutation(ctx);
  return withInvitationLifecycleLock(id, async () => {
    const before = await repos.invitation.findById(id), user = await repos.user.findById(ctx.userId);
    if (!before || !user || before.email.toLowerCase() !== user.email.toLowerCase()) throw new NotFoundError("Invitation", id);
    const plan = status === "accepted" ? await prepareGrantPlan(before) : { pendingIds: [], grants: [], inviter: null };
    const inviter = status === "accepted" ? plan.inviter ?? await resolveInviter(before) : null;
    const result = await db.transaction(async tx => {
      const [organization] = await tx.select().from(schema.organization).where(eq(schema.organization.id, before.organizationId)).for("update");
      const [invitation] = await tx.select().from(schema.invitation).where(eq(schema.invitation.id, id)).for("update");
      if (!invitation || !user || invitation.email.toLowerCase() !== user.email.toLowerCase()) throw new NotFoundError("Invitation", id);
      if (invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) throw new ConflictError("This invitation is no longer pending");
      if (!organization) throw new NotFoundError("Invitation", id);
      const members = await tx.select().from(schema.member).where(eq(schema.member.organizationId, organization.id));
      if (members.some(member => member.userId === ctx.userId)) throw new ConflictError("You already belong to this organization");
      if (status === "accepted" && members.length >= organizationOptions.membershipLimit)
        throw new AppError("The organization membership limit has been reached", 403, "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED");
      if (inviter) await checkInviter(tx, invitation, inviter);
      const [updated] = await tx.update(schema.invitation).set({ status }).where(eq(schema.invitation.id, id)).returning();
      if (status === "rejected") {
        await createInvitationPendingGrantRepo(tx).deleteByInvitation(id);
        return { invitation: { ...updated!, status }, organization: { ...organization, slug: organization.slug ?? organization.id }, user, member: null, materialized: 0 };
      }
      const [member] = await tx.insert(schema.member).values({ id: generateId("mem"), organizationId: organization.id, userId: ctx.userId, role: invitation.role }).returning();
      const materialized = await materializeInTransaction(tx, updated!, ctx.userId, plan);
      return { invitation: { ...updated!, status }, organization: { ...organization, slug: organization.slug ?? organization.id }, user, member: member!, materialized };
    });
    if (result.member) await organizationOptions.organizationHooks.afterAcceptInvitation({ ...result, member: result.member });
    else await organizationOptions.organizationHooks.afterRejectInvitation(result);
    return result;
  });
}

export async function acceptInvitation(ctx: ExecutionContext, id: string) {
  const result = await claim(ctx, id, "accepted");
  return { organizationId: result.organization.id, member: result.member!, materialized: result.materialized };
}
export async function rejectInvitation(ctx: ExecutionContext, id: string) {
  await claim(ctx, id, "rejected");
  return { rejected: true };
}
export async function cancelInvitation(ctx: ExecutionContext, id: string) {
  assertOrgAdmin(ctx);
  return withInvitationLifecycleLock(id, async () => {
    const result = await db.transaction(async tx => {
      const { organization } = await lockOrganization(tx, ctx);
      const [invitation] = await tx.select().from(schema.invitation).where(and(eq(schema.invitation.id, id), eq(schema.invitation.organizationId, ctx.organizationId))).for("update");
      if (!invitation) throw new NotFoundError("Invitation", id);
      if (invitation.status !== "pending") throw new ConflictError("The invitation is no longer pending");
      await tx.update(schema.invitation).set({ status: "canceled" }).where(eq(schema.invitation.id, id));
      await createInvitationPendingGrantRepo(tx).deleteByInvitation(id);
      return { invitation: { ...invitation, status: "canceled" as const }, organization: { ...organization, slug: organization.slug ?? organization.id } };
    });
    await organizationOptions.organizationHooks.afterCancelInvitation({ ...result, cancelledBy: (await repos.user.findById(ctx.userId))! });
    return { canceled: true };
  });
}

export async function listMembers(ctx: ExecutionContext) {
  const members = await repos.member.listByOrganization(ctx.organizationId);
  return ctx.role === "restricted" || ctx.tokenScope ? members.filter(member => member.userId === ctx.userId) : members;
}

export async function setMemberRole(ctx: ExecutionContext, userId: string, input: { role: ContextRole }) {
  assertOrgAdmin(ctx);
  return mutateMember(ctx, userId, input.role);
}
export async function removeMember(ctx: ExecutionContext, userId: string) {
  if (userId !== ctx.userId) assertOrgAdmin(ctx);
  else if (ctx.tokenScope) throw new AppError("A scoped credential cannot change account memberships", 403, "ACCOUNT_LIFECYCLE_DENIED");
  await mutateMember(ctx, userId, null);
  return { removed: true };
}
async function mutateMember(ctx: ExecutionContext, userId: string, role: ContextRole | null) {
  const result = await db.transaction(async tx => {
    const { organization, context } = await lockOrganization(tx, ctx, !(userId === ctx.userId && role === null));
    const members = await tx.select().from(schema.member).where(eq(schema.member.organizationId, ctx.organizationId));
    const member = members.find(member => member.userId === userId);
    if (!member) throw new NotFoundError("Member", userId);
    if ((member.role === "owner" || role === "owner") && context.role !== "owner")
      throw new AppError("Only an owner can change ownership", 403, "ORG_OWNER_REQUIRED");
    await changeMembership(tx, ctx.organizationId, userId, role);
    return { organization: { ...organization, slug: organization.slug ?? organization.id }, member: { ...member, role: role ?? member.role }, previousRole: member.role };
  });
  const user = (await repos.user.findById(ctx.userId))!;
  if (role === null) await organizationOptions.organizationHooks.afterRemoveMember({ ...result, user });
  else await organizationOptions.organizationHooks.afterUpdateMemberRole({ ...result, user });
  return result.member;
}

export async function resendInvitation(ctx: ExecutionContext, id: string, input: { delivery?: "email" | "link" } = {}) {
  assertOrgAdmin(ctx);
  return withInvitationLifecycleLock(id, async () => {
    const before = await repos.invitation.findById(id);
    if (!before || before.organizationId !== ctx.organizationId) throw new NotFoundError("Invitation", id);
    const pending = await repos.invitationPendingGrant.listByInvitation(id);
    const { normalizeGrants } = await import("./permissions.service");
    await normalizeGrants(ctx, pending);
    const user = (await repos.user.findById(ctx.userId))!;
    const authority = await captureExecutionAuthority(ctx);
    const org = (await repos.organization.findById(ctx.organizationId))!;
    await organizationOptions.organizationHooks.beforeCreateInvitation({
      invitation: { organizationId: ctx.organizationId, email: before.email, role: before.role, inviterId: ctx.userId },
      inviter: user, organization: { ...org, slug: org.slug ?? org.id },
    }).catch(providerError);
    const result = await db.transaction(async tx => {
      const { organization, member } = await lockOrganization(tx, ctx);
      const [invitation] = await tx.select().from(schema.invitation).where(and(eq(schema.invitation.id, id), eq(schema.invitation.organizationId, ctx.organizationId))).for("update");
      if (!invitation || invitation.status !== "pending") throw new ConflictError("The invitation is no longer pending");
      if (invitation.role === "owner" && member.role !== "owner") throw new AppError("Only an owner may invite another owner", 403, "ORG_OWNER_REQUIRED");
      const [updated] = await tx.update(schema.invitation).set({
        expiresAt: new Date(Date.now() + organizationOptions.invitationExpiresIn * 1000),
        executionAuthority: authority, inviterId: ctx.userId,
      }).where(eq(schema.invitation.id, id)).returning();
      return { invitation: { ...updated!, status: "pending" as const }, organization: { ...organization, slug: organization.slug ?? organization.id }, member };
    });
    if (input.delivery !== "link" && smtpEnabled) await deliverOrganizationInvitation({
      id, email: result.invitation.email, role: result.invitation.role, invitation: result.invitation,
      organization: result.organization, inviter: { ...result.member, user },
    }).catch(providerError);
    audit.recordAsync(operationAuditContext(ctx), { eventType: "invitation.resent", resourceType: "invitation", resourceId: id, after: { pendingGrantCount: pending.length } });
    return { id, email: result.invitation.email, role: result.invitation.role, pendingGrantCount: pending.length };
  });
}
