import { AppError } from "@repo/core";
import { repos, type Deployment, type Project } from "@repo/db";
import { tryWithCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { collectDeploymentManifest, executeCleanup } from "../projects/project-cleanup.service";

function matchesDestination(dep: Deployment, project: Project): boolean {
  const meta = dep.meta as { deployTarget?: string; serverId?: string; managedWorkspaceId?: string } | null;
  return !!project.workspaceId && dep.organizationId === project.organizationId && dep.projectId === project.id &&
    meta?.deployTarget === "cloud" && meta.serverId === project.serverId &&
    (!meta.managedWorkspaceId || meta.managedWorkspaceId === project.workspaceId);
}

/** A terminal deployment may outlive its controller. Reuse the same server
 * fence and remote-command recovery as the worker, never an elapsed-time guess.
 * A worker still waiting for that fence rechecks the durable cancellation before
 * entering the pipeline. Live/retained releases and volumes remain protected. */
export async function recoverManagedDeploymentExecution(dep: Deployment, project: Project): Promise<boolean> {
  if (["queued", "building", "deploying"].includes(dep.status)) return false;
  if (!project.workspaceId || !matchesDestination(dep, project)) return false;

  return (await tryWithCloudWorkspaceActivity(project.workspaceId, async () => {
    const [current, owner] = await Promise.all([
      repos.deployment.findById(dep.id), repos.project.findById(project.id),
    ]);
    if (!current || !owner || owner.workspaceId !== project.workspaceId || !matchesDestination(current, owner) ||
        ["queued", "building", "deploying"].includes(current.status)) return false;
    const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
    if (!session || session.finishedAt) return true;

    const keep = (current.meta as { cancellation?: { keepProvisioned?: boolean } } | null)
      ?.cancellation?.keepProvisioned === true;
    if (!keep && (current.status === "cancelled" || current.status === "failed")) {
      const manifest = await collectDeploymentManifest(current, owner, { protectRetained: true });
      const cleanup = await executeCleanup(manifest);
      if (cleanup.failed.length) throw new AppError(
        "The interrupted deployment could not finish cleanup. Retry cancellation when the server is reachable.",
        503, "DEPLOYMENT_RECOVERY_PENDING",
      );
    }
    await repos.deployment.acknowledgeBuildExecutionFinished(session.id);
    return true;
  }, `project:${project.id}`)) === true;
}
