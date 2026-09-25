import { PermissionCollectionSchemas, PermissionResourceSchemas, type PermissionOperations, isRecord } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations, createRemoteResourceOperations } from "./resource-client";
export function createRemotePermissionOperations(http: HttpClient): PermissionOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, PermissionCollectionSchemas, {
      listWorkspaces: { method: "GET", path: () => "/permissions/workspaces", envelope: "data" },
      orgMeta: { method: "GET", path: () => "/permissions/org-meta", envelope: "data" },
      listResources: { method: "GET", path: () => "/permissions/resources", envelope: "data" },
      createTeamOrg: { method: "POST", path: () => "/permissions/create-team-org", envelope: "data" },
      listGrants: { method: "GET", path: () => "/permissions/grants", envelope: "data" },
      upsertGrant: { method: "POST", path: () => "/permissions/grants", envelope: "data" },
      replaceGrants: { method: "PUT", path: () => "/permissions/grants", envelope: "data" },
      listInvitations: { method: "GET", path: () => "/permissions/invitations", envelope: "data" },
      inviteWithGrants: { method: "POST", path: () => "/permissions/invite-with-grants", envelope: "data" },
      listMembers: { method: "GET", path: () => "/permissions/members", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, PermissionResourceSchemas, {
      materializeInvitation: { method: "POST", path: id => `/permissions/invitations/${encodeURIComponent(id)}/materialize`, envelope: "data" },
      deleteGrant: { method: "DELETE", path: id => `/permissions/grants/${encodeURIComponent(id)}`, response: body => ({ revoked: isRecord(body) && body.revoked === true }) },
      acceptInvitation: { method: "POST", path: id => `/permissions/invitations/${encodeURIComponent(id)}/accept`, envelope: "data" },
      rejectInvitation: { method: "POST", path: id => `/permissions/invitations/${encodeURIComponent(id)}/reject`, envelope: "data" },
      cancelInvitation: { method: "POST", path: id => `/permissions/invitations/${encodeURIComponent(id)}/cancel`, envelope: "data" },
      resendInvitation: { method: "POST", path: id => `/permissions/invitations/${encodeURIComponent(id)}/resend`, envelope: "data" },
      setMemberRole: { method: "PATCH", path: id => `/permissions/members/${encodeURIComponent(id)}`, envelope: "data" },
      removeMember: { method: "DELETE", path: id => `/permissions/members/${encodeURIComponent(id)}`, envelope: "data" },
    }),
  });
}
