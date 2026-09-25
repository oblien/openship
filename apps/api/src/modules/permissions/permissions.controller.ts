/** HTTP paths and legacy envelopes over the shared permission operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";
import { INVITATION_DELIVERY_HEADER, INVITATION_DELIVERY_LINK_ONLY } from "@repo/core";
const operations = () => getPlatformKernel().permissions;
export async function listWorkspaces(c: Context) { return c.json({ data: await operationData(c, operations().listWorkspaces(operationContext(c))) }); }
export async function orgMeta(c: Context) { return c.json({ data: await operationData(c, operations().orgMeta(operationContext(c))) }); }
export async function listResources(c: Context) { return c.json({ data: await operationData(c, operations().listResources(operationContext(c), { type: c.req.query("type") ?? "", ...(c.req.query("owner") ? { owner: c.req.query("owner") } : {}) })) }); }
export async function createTeamOrg(c: Context) { return c.json({ data: await operationData(c, operations().createTeamOrg(operationContext(c), await c.req.json())) }, 201); }
export async function listGrants(c: Context) { return c.json({ data: await operationData(c, operations().listGrants(operationContext(c), { userId: c.req.query("userId") ?? "" })) }); }
export async function upsertGrant(c: Context) {
  const data = await operationData(c, operations().upsertGrant(operationContext(c), await c.req.json()));
  return data ? c.json({ data }, 201) : c.json({ data, revoked: true });
}
export async function replaceGrants(c: Context) { return c.json({ data: await operationData(c, operations().replaceGrants(operationContext(c), await c.req.json())) }); }
export async function deleteGrant(c: Context) {
  const data = await operationData(c, operations().deleteGrant(operationContext(c), param(c, "id")));
  return c.json({ data: null, ...data });
}
export async function listInvitations(c: Context) { return c.json({ data: await operationData(c, operations().listInvitations(operationContext(c))) }); }
export async function inviteWithGrants(c: Context) {
  const body = await c.req.json();
  if (c.req.header(INVITATION_DELIVERY_HEADER) === INVITATION_DELIVERY_LINK_ONLY) body.delivery = "link";
  return c.json({ data: await operationData(c, operations().inviteWithGrants(operationContext(c), body)) }, 201);
}
export async function materializeInvitation(c: Context) { return c.json({ data: await operationData(c, operations().materializeInvitation(operationContext(c), param(c, "id"))) }); }
export async function acceptInvitation(c: Context) { return c.json({ data: await operationData(c, operations().acceptInvitation(operationContext(c), param(c, "id"))) }); }
export async function rejectInvitation(c: Context) { return c.json({ data: await operationData(c, operations().rejectInvitation(operationContext(c), param(c, "id"))) }); }
export async function cancelInvitation(c: Context) { return c.json({ data: await operationData(c, operations().cancelInvitation(operationContext(c), param(c, "id"))) }); }
export async function resendInvitation(c: Context) { return c.json({ data: await operationData(c, operations().resendInvitation(operationContext(c), param(c, "id"), await c.req.json().catch(() => ({})))) }); }
export async function listMembers(c: Context) { return c.json({ data: await operationData(c, operations().listMembers(operationContext(c))) }); }
export async function setMemberRole(c: Context) { return c.json({ data: await operationData(c, operations().setMemberRole(operationContext(c), param(c, "id"), await c.req.json())) }); }
export async function removeMember(c: Context) { return c.json({ data: await operationData(c, operations().removeMember(operationContext(c), param(c, "id"))) }); }
