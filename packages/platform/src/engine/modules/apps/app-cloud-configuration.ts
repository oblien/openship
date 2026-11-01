import { repos } from "@repo/db";
import { AppError, type AppTemplate } from "@repo/core";
import { getTemplateForOrg } from "./catalog-source";
import { workspaceForServer } from "../../lib/cloud-workspace-scope";

/** Preview only saved service/project limits. Catalog sizing recommendations
 * are advisory and never become the configuration of an install or retry. */
export async function appCloudConfiguration(
  organizationId: string,
  template: AppTemplate,
  projectId?: string,
  serverId?: string,
) {
  const project = projectId
    ? await repos.project.findByIdInOrganization(projectId, organizationId)
    : undefined;
  if (
    projectId &&
    (!project ||
      project.deletedAt ||
      project.deletionInProgress ||
      project.appTemplateId !== template.id)
  ) {
    throw new AppError("App project not found", 404, "PROJECT_NOT_FOUND");
  }
  if (project && serverId && serverId !== project.serverId)
    throw new AppError(
      "The selected server differs from this project",
      409,
      "PROJECT_SERVER_TARGET_CONFLICT",
    );
  const selectedServerId = project?.serverId ?? serverId;
  const selected = selectedServerId
    ? await workspaceForServer(organizationId, selectedServerId)
    : null;
  if (selected && !selected.workspace)
    throw new AppError("Choose a managed Cloud server", 400, "CLOUD_WORKSPACE_TARGET_UNAVAILABLE");
  const workspaceId = selected?.workspace?.id ?? project?.workspaceId ?? undefined;
  const saved = project ? await repos.service.listByProject(project.id) : [];
  const savedByName = new Map(saved.map((service) => [service.name, service]));
  const profiles = new Map((template.services ?? []).map((service) => [service.name, service]));
  // An adopted draft deploys its saved service set. A removed component must
  // not silently reappear in its preview or consume a phantom service slot.
  const names = project ? savedByName.keys() : profiles.keys();
  return {
    projectId,
    workspaceId,
    resources: project?.resources as Record<string, unknown> | null | undefined,
    buildResources: project?.buildResources as Record<string, unknown> | null | undefined,
    services: [...names].map((name) => {
      const stored = savedByName.get(name);
      const spec = profiles.get(name);
      return {
        name,
        kind: stored?.kind ?? "compose",
        enabled: stored?.enabled ?? true,
        image: stored ? stored.image : spec?.image,
        build: stored?.build,
        advanced: {
          build: stored ? stored.advanced?.build : spec?.build,
          resources: stored?.advanced?.resources,
        },
      };
    }),
  };
}
