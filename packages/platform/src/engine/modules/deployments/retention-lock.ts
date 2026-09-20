import { repos, type Project } from "@repo/db";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";

/** Shares the deployment-admission lock, so a sweep cannot delete an image
 * between a queued deployment claiming it and creating its container. */
export function withRetentionLock<T>(
  projectId: string,
  action: (project: Project) => Promise<T>,
): Promise<T | undefined> {
  return withLiveProjectRuntimeMutation(projectId, async (project) => {
    const inFlight = await repos.deployment.listInFlightByProject(projectId);
    if (inFlight.length > 0) return undefined;
    return action(project);
  });
}
