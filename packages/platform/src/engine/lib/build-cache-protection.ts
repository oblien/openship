import { repos } from "@repo/db";

/** Called under the host mutation lock, before worker attachment or GC.
 * Pending commands stay protective until recovery confirms exit. A linked
 * controller's older singleton activity protects the whole host when its
 * pending command cannot be attributed to one project. */
export async function buildCacheProtection(organizationId: string, workspaceId: string) {
  const [active, workspace] = await Promise.all([
    repos.cloudBuildActivity.listActive(workspaceId, organizationId),
    repos.cloudWorkspace.findByIdInOrganization(workspaceId, organizationId),
  ]);
  if (!workspace) throw new Error("Build-cache host ownership changed");
  return {
    projectIds: active.filter((row) => row.commands.length).map((row) => row.projectId),
    all: Boolean(workspace.activity?.commands?.length),
  };
}
