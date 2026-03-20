import { repos, type Deployment, type Project } from "@repo/db";
import { normalizeRollbackWindow } from "../../lib/release-retention";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";

export async function resolveRollbackWindow(project: Pick<Project, "rollbackWindow">): Promise<number> {
  if (project.rollbackWindow !== null && project.rollbackWindow !== undefined) {
    return normalizeRollbackWindow(project.rollbackWindow);
  }

  const settings = await repos.instanceSettings.get();
  return normalizeRollbackWindow(settings?.defaultRollbackWindow);
}

export async function pruneRetainedBareReleases(
  project: Project,
  currentDeployment: Deployment,
): Promise<void> {
  const rollbackWindow = await resolveRollbackWindow(project);
  const { rows } = await repos.deployment.listByProject(project.id, {
    perPage: 1000,
    environment: currentDeployment.environment,
  });

  let retainedPrevious = 0;

  for (const dep of rows) {
    if (dep.id === currentDeployment.id || dep.status !== "ready" || !dep.containerId) {
      continue;
    }

    let runtime;
    try {
      runtime = await resolveDeploymentRuntime(dep);
    } catch {
      continue;
    }

    if (runtime.name !== "bare") continue;

    if (retainedPrevious < rollbackWindow) {
      retainedPrevious += 1;
      continue;
    }

    try {
      await runtime.destroy(dep.containerId);
      await repos.deployment.updateStatus(dep.id, dep.status, {
        containerId: null,
        url: null,
      });
    } catch (err) {
      console.error(`[DEPLOY] Failed to prune retained release ${dep.id}:`, err);
    }
  }
}