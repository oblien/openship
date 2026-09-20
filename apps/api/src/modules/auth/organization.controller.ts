/** Compatibility envelopes for Better Auth's organization URLs. Identity and
 * cookie handling stay here; every mutation enters the shared operation layer. */
import type { Context } from "hono";
import { AppError, NotFoundError } from "@repo/core";
import { ResourceIdSchema, parseInput } from "@repo/contracts";
import { authorization } from "@repo/platform/engine/lib/authorization";
import { db, schema, repos, eq, and } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { INVITATION_DELIVERY_HEADER, INVITATION_DELIVERY_LINK_ONLY } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import { freezeContext } from "@repo/platform";

const operations = () => getPlatformKernel().permissions;
async function targetContext(c: Context, organizationId?: string): Promise<ExecutionContext> {
  const ctx = operationContext(c);
  if (!organizationId || organizationId === ctx.organizationId) return ctx;
  parseInput(ResourceIdSchema, organizationId);
  if (ctx.scopeMode === "fixed") throw new NotFoundError("Organization", organizationId);
  const current = await authorization.resolveScope({
    user: ctx.user, sessionId: ctx.sessionId, sessionKind: ctx.sessionKind,
    principalKind: ctx.principalKind, tokenScope: ctx.tokenScope, credential: ctx.credential,
  }, organizationId);
  // Scope selection requires membership. The shared operation applies its
  // own admin or self-management policy, including for restricted members.
  return freezeContext({ ...ctx, organizationId, role: current.role, membershipId: current.membershipId });
}
function invitationResponse(row: NonNullable<Awaited<ReturnType<typeof repos.invitation.findById>>>) {
  return { id: row.id, organizationId: row.organizationId, email: row.email, role: row.role, status: row.status, inviterId: row.inviterId, expiresAt: row.expiresAt, createdAt: row.createdAt };
}
async function restoreSessionOrganization(c: Context, organizationId: string) {
  const ctx = operationContext(c);
  if (ctx.principalKind || ctx.sessionKind === "zero-auth") return;
  // This is a cookie/session selection operation, not a native execution path.
  await auth.api.setActiveOrganization({ headers: c.req.raw.headers, body: { organizationId } });
}
export async function inviteMember(c: Context) {
  const body = await c.req.json();
  if (body.teamId) throw new AppError("Teams are not enabled on this instance", 400, "TEAMS_UNAVAILABLE");
  if (Array.isArray(body.role) && body.role.length === 1) body.role = body.role[0];
  if (c.req.header(INVITATION_DELIVERY_HEADER) === INVITATION_DELIVERY_LINK_ONLY) body.delivery = "link";
  const ctx = await targetContext(c, body.organizationId);
  const existing = body.resend && typeof body.email === "string"
    ? (await repos.invitation.listPendingByOrg(ctx.organizationId)).find(invitation => invitation.email.toLowerCase() === body.email.trim().toLowerCase())
    : undefined;
  const result = await operationData(c, existing
    ? operations().resendInvitation(ctx, existing.id, { delivery: body.delivery })
    : operations().inviteWithGrants(ctx, body));
  const row = (await repos.invitation.findById(result.id))!;
  return c.json(invitationResponse(row));
}
export async function acceptInvitation(c: Context) {
  const { invitationId } = await c.req.json();
  const result = await operationData(c, operations().acceptInvitation(operationContext(c), invitationId));
  await restoreSessionOrganization(c, result.organizationId);
  return c.json({ invitation: invitationResponse((await repos.invitation.findById(invitationId))!), member: result.member });
}
export async function rejectInvitation(c: Context) {
  const { invitationId } = await c.req.json();
  await operationData(c, operations().rejectInvitation(operationContext(c), invitationId));
  return c.json({ invitation: invitationResponse((await repos.invitation.findById(invitationId))!), member: null });
}
export async function cancelInvitation(c: Context) {
  const { invitationId } = await c.req.json();
  const row = await repos.invitation.findById(invitationId);
  if (!row) throw new NotFoundError("Invitation", invitationId);
  await operationData(c, operations().cancelInvitation(await targetContext(c, row.organizationId), invitationId));
  return c.json({ ...invitationResponse(row), status: "canceled" });
}
async function memberTarget(ctx: ExecutionContext, idOrEmail: string) {
  parseInput(ResourceIdSchema, idOrEmail);
  const rows = await repos.member.listByOrganization(ctx.organizationId);
  const member = rows.find(member => member.id === idOrEmail || member.user.email.toLowerCase() === idOrEmail.toLowerCase());
  if (!member) throw new NotFoundError("Member", idOrEmail);
  return member;
}
export async function updateMemberRole(c: Context) {
  const body = await c.req.json();
  const ctx = await targetContext(c, body.organizationId);
  const member = await memberTarget(ctx, body.memberId);
  return c.json(await operationData(c, operations().setMemberRole(ctx, member.userId, { role: Array.isArray(body.role) && body.role.length === 1 ? body.role[0] : body.role })));
}
export async function removeMember(c: Context) {
  const body = await c.req.json();
  const ctx = await targetContext(c, body.organizationId);
  const member = await memberTarget(ctx, body.memberIdOrEmail);
  await operationData(c, operations().removeMember(ctx, member.userId));
  return c.json({ member: { id: member.id, organizationId: member.organizationId, userId: member.userId, role: member.role, createdAt: member.createdAt } });
}
export async function leaveOrganization(c: Context) {
  const body = await c.req.json();
  const ctx = await targetContext(c, body.organizationId);
  await operationData(c, operations().removeMember(ctx, ctx.userId));
  // An active cookie cannot keep pointing at a membership it just left.
  await db.update(schema.session).set({ activeOrganizationId: `org_${ctx.userId}` })
    .where(and(eq(schema.session.id, ctx.sessionId), eq(schema.session.userId, ctx.userId), eq(schema.session.activeOrganizationId, ctx.organizationId)));
  return c.json({ status: true });
}
