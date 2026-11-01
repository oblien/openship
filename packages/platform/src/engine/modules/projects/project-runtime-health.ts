import { repos, type Project, type ServiceIncident } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import { env } from "../../config";

type RuntimeProject = Pick<
  Project,
  "id" | "organizationId" | "activeDeploymentId" | "disabledAt"
>;

/** Read the existing health watch's durable state. Never sample a runtime,
 * schedule another watcher, change deployment outcomes, or send notifications. */
export async function loadProjectRuntimeHealth(
  projects: readonly RuntimeProject[],
): Promise<Map<string, ServiceIncident[]>> {
  const out = new Map<string, ServiceIncident[]>();
  if (env.CLOUD_MODE) return out; // Continuous container health is self-hosted.
  const scopes = projects
    .filter((project) => project.activeDeploymentId && !project.disabledAt)
    .map((project) => ({
      id: project.id,
      organizationId: project.organizationId,
      activeDeploymentId: project.activeDeploymentId!,
    }));
  if (scopes.length === 0) return out;
  try {
    const owners = new Map(
      scopes.map((scope) => [scope.id, scope.organizationId]),
    );
    for (const incident of await repos.serviceIncident.listOpenForActiveProjects(
      scopes,
    )) {
      if (
        !incident.projectId ||
        owners.get(incident.projectId) !== incident.organizationId ||
        incident.status !== "open"
      )
        continue;
      const rows = out.get(incident.projectId) ?? [];
      rows.push(incident);
      out.set(incident.projectId, rows);
    }
  } catch (error) {
    reportCaughtError(error, "projects/runtime-health");
  }
  return out;
}
