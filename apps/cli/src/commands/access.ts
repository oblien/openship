import { Command } from "commander";
import { PermissionCollectionSchemas, PermissionResourceSchemas, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const accessCommand = new Command("access").description("Manage workspaces, members, invitations and resource grants");
accessCommand.command("workspaces").description("List accessible workspaces and whether this credential can select an organization")
  .action(() => printResult(() => getShipClient().permissions.listWorkspaces()));
accessCommand.command("organization").description("Show the current organization and member count")
  .action(() => printResult(() => getShipClient().permissions.orgMeta()));
accessCommand.command("create-team").argument("<name>", "Workspace name").option("--slug <slug>", "Workspace slug")
  .description("Create a team workspace; select its ID with the global --organization option")
  .action((name: string, opts) => printResult(() => getShipClient().permissions.createTeamOrg({ name, slug: opts.slug })));
accessCommand.command("resources").argument("<type>", "Resource type").option("--owner <id>", "Resource owner filter")
  .description("List resources available for permission grants")
  .action((type: string, opts) => printResult(() => getShipClient().permissions.listResources({ type, owner: opts.owner })));
const members = new Command("members").description("Manage membership in the selected workspace");
members.command("list").description("List workspace members")
  .action(() => printResult(() => getShipClient().permissions.listMembers()));
members.command("role").argument("<id>", "Member ID").argument("<role>", "owner | admin | member | restricted")
  .description("Change a member's role through the shared permission rules")
  .action((id: string, role: string) => printResult(() => getShipClient().permissions.setMemberRole(id,
    parseInput(PermissionResourceSchemas.setMemberRole.input, { role }))));
members.command("remove").argument("<id>", "Member ID").option("-y, --yes", "Skip confirmation")
  .description("Remove a workspace member")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove member ${id}?`);
    return getShipClient().permissions.removeMember(id);
  }));
accessCommand.addCommand(members);
const grants = new Command("grants").description("Manage per-resource access grants");
grants.command("list").argument("<user>", "User ID").description("List a user's resource grants")
  .action((userId: string) => printResult(() => getShipClient().permissions.listGrants({ userId })));
grants.command("set").argument("<file>", "JSON grant with userId, resourceType, resourceId and permissions")
  .description("Create or update one resource grant")
  .action((file: string) => printResult(() => getShipClient().permissions.upsertGrant(
    parseInput(PermissionCollectionSchemas.upsertGrant.input, readJsonInput(file)))));
grants.command("replace").argument("<file>", "JSON object with userId and the complete grants array")
  .description("Replace a user's complete resource grant set").option("-y, --yes", "Skip confirmation")
  .action((file: string, opts) => printResult(async () => {
    const input = parseInput(PermissionCollectionSchemas.replaceGrants.input, readJsonInput(file));
    await confirmOrExit(opts.yes, `Replace all resource grants for ${input.userId}?`);
    return getShipClient().permissions.replaceGrants(input);
  }));
grants.command("remove").argument("<id>", "Grant ID").description("Revoke one resource grant")
  .action((id: string) => printResult(() => getShipClient().permissions.deleteGrant(id)));
accessCommand.addCommand(grants);
const invitations = new Command("invitations").description("Manage workspace invitations");
invitations.command("list").description("List pending invitations")
  .action(() => printResult(() => getShipClient().permissions.listInvitations()));
invitations.command("create").argument("<file>", "JSON invitation with email, optional role, grants and delivery")
  .description("Invite a member with optional resource grants")
  .action((file: string) => printResult(() => getShipClient().permissions.inviteWithGrants(
    parseInput(PermissionCollectionSchemas.inviteWithGrants.input, readJsonInput(file)))));
for (const [name, method] of [
  ["accept", "acceptInvitation"], ["reject", "rejectInvitation"], ["cancel", "cancelInvitation"],
] as const) {
  invitations.command(name).argument("<id>", "Invitation ID").description(`${name} a workspace invitation`)
    .action((id: string) => printResult(() => getShipClient().permissions[method](id)));
}
invitations.command("resend").argument("<id>", "Invitation ID").option("--delivery <mode>", "email | link")
  .description("Resend an existing invitation")
  .action((id: string, opts) => printResult(() => getShipClient().permissions.resendInvitation(id,
    parseInput(PermissionResourceSchemas.resendInvitation.input, { delivery: opts.delivery }))));
accessCommand.addCommand(invitations);
invitations.command("materialize").argument("<id>", "Accepted invitation ID")
  .description("Recover resource grants from an already-accepted invitation")
  .action((id: string) => printResult(() => getShipClient().permissions.materializeInvitation(id)));
