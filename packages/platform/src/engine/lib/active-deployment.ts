import { repos, type Deployment, type Project } from "@repo/db";
import { deploymentBelongsToProject } from "@repo/core";

type ActiveProject = Pick<Project, "id" | "organizationId" | "activeDeploymentId">;

/** Validate a preloaded candidate too: batch maps may contain other projects. */
export function activeDeploymentForProject(
  project: ActiveProject,
  candidate: Deployment | null | undefined,
): Deployment | undefined {
  return candidate &&
    candidate.id === project.activeDeploymentId &&
    deploymentBelongsToProject(project, candidate)
    ? candidate
    : undefined;
}

/** An editable/imported active pointer is a reference, never workload authority. */
export async function findActiveDeployment(
  project: ActiveProject,
): Promise<Deployment | undefined> {
  if (!project.activeDeploymentId) return undefined;
  return findProjectDeployment(project, project.activeDeploymentId);
}

/** Explicit references (new releases and rollback predecessors) need the same owner. */
export async function findProjectDeployment(
  project: Pick<Project, "id" | "organizationId">,
  deploymentId: string,
): Promise<Deployment | undefined> {
  const candidate = await repos.deployment.findById(deploymentId);
  return candidate?.id === deploymentId && deploymentBelongsToProject(project, candidate)
    ? candidate
    : undefined;
}

/** Service rows carry container IDs too, so they require the same validated parent. */
export async function listActiveServiceDeployments(project: ActiveProject) {
  const deployment = await findActiveDeployment(project);
  return deployment ? repos.service.listByDeployment(deployment.id) : [];
}
