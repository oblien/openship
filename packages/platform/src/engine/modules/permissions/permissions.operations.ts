import type { PermissionDependencies } from "../../../permissions";
import * as service from "./permissions.service";
import * as organization from "./organization.service";
export const permissionsDependencies: PermissionDependencies = {
  collection: {
    listWorkspaces: organization.listWorkspaces,
    orgMeta: service.orgMeta, listResources: service.listResources, createTeamOrg: service.createTeamOrg,
    listGrants: service.listGrants, upsertGrant: service.upsertGrant, replaceGrants: service.replaceGrants,
    listInvitations: service.listInvitations, inviteWithGrants: service.inviteWithGrants, listMembers: organization.listMembers,
  },
  resources: {
    materializeInvitation: service.materializeInvitation, deleteGrant: service.deleteGrant,
    acceptInvitation: organization.acceptInvitation, rejectInvitation: organization.rejectInvitation, cancelInvitation: organization.cancelInvitation,
    resendInvitation: organization.resendInvitation,
    setMemberRole: organization.setMemberRole, removeMember: organization.removeMember,
  },
};
