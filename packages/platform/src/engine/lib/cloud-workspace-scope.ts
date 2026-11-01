import { AppError } from "@repo/core";
import { repos, type CloudWorkspace } from "@repo/db";
import { createProvisionLock } from "./provision-lock";

/** Optional selector; absent selection is valid only when the organization has one server. */
export type CloudWorkspaceScope = string | null | undefined;

export async function requireCloudWorkspace(
  organizationId: string,
  workspaceId: string,
): Promise<CloudWorkspace> {
  const workspace = await repos.cloudWorkspace.findByIdInOrganization(workspaceId, organizationId);
  if (!workspace) throw new AppError("Cloud workspace not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
  return workspace;
}

/** Every workspace has exactly one execution identity, created in the same transaction. */
export async function requireWorkspaceServer(organizationId: string, workspaceId: string) {
  const server = await repos.server.findByWorkspace(workspaceId, organizationId);
  if (!server) throw new AppError("Cloud workspace has no managed server", 409, "CLOUD_WORKSPACE_SERVER_MISSING");
  return server;
}

/** Resolve a selected host to its Cloud owner without provisioning or default selection. */
export async function workspaceForServer(organizationId: string, serverId: string) {
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) throw new AppError("Server not found", 404, "SERVER_NOT_FOUND");
  return { server, workspace: server.workspaceId ? await requireCloudWorkspace(organizationId, server.workspaceId) : null };
}

/** Write-path placement. A new organization may create its initial workspace;
 * previews use workspaceForServer/cloudBillingOwner and never create resources. */
export async function resolveCloudProjectServer(organizationId: string, serverId?: string) {
  if (serverId) {
    const selected = await workspaceForServer(organizationId, serverId);
    if (!selected.workspace) throw new AppError("Choose a managed Cloud server", 400, "CLOUD_WORKSPACE_TARGET_UNAVAILABLE");
    return selected;
  }
  const workspace = await ensureDefaultCloudWorkspace(organizationId);
  return { workspace, server: workspace ? await requireWorkspaceServer(organizationId, workspace.id) : null };
}

/** Read-only resolution. Never guesses between independent paid subscriptions. */
export async function cloudBillingOwner(organizationId: string, workspaceId?: CloudWorkspaceScope) {
  const org = await repos.organization.findById(organizationId);
  if (!org) throw new AppError("Organization not found", 404, "ORGANIZATION_NOT_FOUND");
  let workspace: CloudWorkspace | undefined;
  if (workspaceId) workspace = await requireCloudWorkspace(organizationId, workspaceId);
  else {
    const rows = await repos.cloudWorkspace.listByOrganization(organizationId);
    if (rows.length > 1)
      throw new AppError(
        "Choose the Cloud workspace for this operation",
        400,
        "CLOUD_WORKSPACE_REQUIRED",
      );
    workspace = rows[0];
  }
  return {
    organizationId,
    workspace,
    workspaceId: workspace?.id ?? null,
    key: workspace ? `workspace:${workspace.id}` : organizationId,
    namespace: workspace?.namespace ?? null,
    planTierId: workspace?.planTierId ?? "free",
    subscriptionStatus: workspace?.subscriptionStatus ?? "active",
    currentPeriodStart: workspace?.currentPeriodStart ?? null,
    currentPeriodEnd: workspace?.currentPeriodEnd ?? null,
    createdAt: workspace?.createdAt ?? org.createdAt,
  };
}

/** The first deployment or checkout creates a single managed server identity. */
export async function ensureDefaultCloudWorkspace(
  organizationId: string,
): Promise<CloudWorkspace> {
  return createProvisionLock(`cloud:default-workspace:${organizationId}`).run(async () => {
    const owner = await cloudBillingOwner(organizationId);
    if (owner.workspace) return owner.workspace;
    return repos.cloudWorkspace.create({
      organizationId,
      name: "Production",
    });
  });
}
