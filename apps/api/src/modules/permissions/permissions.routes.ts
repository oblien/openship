import { Hono } from "hono";
import { PermissionCollectionSchemas as Collection, PermissionResourceSchemas as Resource } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./permissions.controller";
const r = secureRouter(new Hono(), { module: "permissions", basePath: "/api/permissions" });
const shared = { authorizationHandledByOperation: true, auditHandledByOperation: true } as const;
r.get("/workspaces", {
  tag: "permissions:read", ...shared,
  mcp: { description: "List the Openship workspaces (organizations/workgroups) available to this credential, including empty workspaces. Returns each name, organizationId, slug and role, plus currentOrganizationId, boundOrganizationId, canSwitchOrganization and readOnly. Call before creating an app or Compose project; pass the chosen organizationId as a top-level tool argument on every call. Bound credentials can only list and target their own workspace." },
}, ctrl.listWorkspaces);
r.get("/org-meta", { tag: "permissions:read", ...shared }, ctrl.orgMeta);
r.get("/resources", { tag: "permissions:read", ...shared }, ctrl.listResources);
r.post("/create-team-org", { tag: "permissions:write", ...shared, body: Collection.createTeamOrg.input }, ctrl.createTeamOrg);
r.get("/grants", { tag: "permissions:read", ...shared }, ctrl.listGrants);
r.post("/grants", { tag: "permissions:write", ...shared, body: Collection.upsertGrant.input }, ctrl.upsertGrant);
r.put("/grants", { tag: "permissions:write", ...shared, body: Collection.replaceGrants.input }, ctrl.replaceGrants);
r.delete("/grants/:id", { tag: "permissions:admin", ...shared }, ctrl.deleteGrant);
r.get("/invitations", { tag: "permissions:read", ...shared }, ctrl.listInvitations);
r.post("/invite-with-grants", { tag: "permissions:write", ...shared, body: Collection.inviteWithGrants.input }, ctrl.inviteWithGrants);
r.post("/invitations/:id/materialize", { tag: "permissions:write", ...shared }, ctrl.materializeInvitation);
r.post("/invitations/:id/accept", { tag: "permissions:write", ...shared }, ctrl.acceptInvitation);
r.post("/invitations/:id/reject", { tag: "permissions:write", ...shared }, ctrl.rejectInvitation);
r.post("/invitations/:id/cancel", { tag: "permissions:write", ...shared }, ctrl.cancelInvitation);
r.post("/invitations/:id/resend", { tag: "permissions:write", ...shared }, ctrl.resendInvitation);
r.get("/members", { tag: "permissions:read", ...shared }, ctrl.listMembers);
r.patch("/members/:id", { tag: "permissions:write", ...shared, body: Resource.setMemberRole.input }, ctrl.setMemberRole);
r.delete("/members/:id", { tag: "permissions:admin", ...shared }, ctrl.removeMember);
export const permissionsRoutes = r.hono;
