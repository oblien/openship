import { AppError } from "@repo/core";
import { repos, type Deployment, type Project } from "@repo/db";
import { tryWithCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { recoverCloudBuildActivity } from "../../lib/cloud-build-activity";
import { env } from "../../config/env";
import { collectDeploymentManifest, executeCleanup } from "../projects/project-cleanup.service";

function matchesDestination(dep: Deployment, project: Project): boolean {
  const meta = dep.meta as {
    deployTarget?: string;
    serverId?: string;
    managedWorkspaceId?: string;
  } | null;
  return (
    !!project.workspaceId &&
    dep.organizationId === project.organizationId &&
    dep.projectId === project.id &&
    meta?.deployTarget === "cloud" &&
    meta.serverId === project.serverId &&
    (!meta.managedWorkspaceId || meta.managedWorkspaceId === project.workspaceId)
  );
}

/** A terminal deployment may outlive its controller. Reuse the same server
 * fence and remote-command recovery as the worker, never an elapsed-time guess.
 * A worker still waiting for that fence rechecks the durable cancellation before
 * entering the pipeline. Live/retained releases and volumes remain protected. */
export async function recoverManagedDeploymentExecution(
  dep: Deployment,
  project: Project,
  options: { recoverInterrupted?: boolean } = {},
): Promise<boolean> {
  if (!options.recoverInterrupted && ["queued", "building", "deploying"].includes(dep.status))
    return false;
  if (!project.workspaceId || !matchesDestination(dep, project)) return false;

  const identity = {
    workspaceId: project.workspaceId,
    organizationId: dep.organizationId,
    projectId: project.id,
    deploymentId: dep.id,
  };
  const activity = env.CLOUD_MODE ? await repos.cloudBuildActivity.find(identity) : null;
  if (activity) {
    const settleDeployment = async () => {
      const current = await repos.deployment.findById(dep.id);
      const owner = await repos.project.findById(project.id);
      if (
        !current ||
        !owner ||
        owner.workspaceId !== identity.workspaceId ||
        !matchesDestination(current, owner)
      )
        throw new AppError(
          "Deployment ownership changed during recovery",
          409,
          "BUILD_OWNERSHIP_MISMATCH",
        );
      if (["queued", "building", "deploying"].includes(current.status)) {
        if (!options.recoverInterrupted)
          throw new AppError(
            "The deployment has not been cancelled",
            409,
            "DEPLOYMENT_RECOVERY_PENDING",
          );
        // The execution-specific live-owner lock proves this controller is gone.
        // Never infer this from heartbeat age or a sibling replica restarting.
        await repos.deployment.updateStatus(current.id, "failed", {
          errorMessage:
            "The deployment was interrupted. Its build resources have been recovered; redeploy to retry.",
          errorCode: "DEPLOYMENT_INTERRUPTED",
        });
        current.status = "failed";
      }
      return { current, owner };
    };
    const recovered = await recoverCloudBuildActivity(
      identity,
      async ({ activated }) => {
        const { current, owner } = await settleDeployment();
        const keep =
          (current.meta as { cancellation?: { keepProvisioned?: boolean } } | null)?.cancellation
            ?.keepProvisioned === true;
        if (activated && !keep && ["cancelled", "failed"].includes(current.status)) {
          const manifest = await collectDeploymentManifest(current, owner, {
            protectRetained: true,
          });
          const cleanup = await executeCleanup(manifest);
          if (cleanup.failed.length)
            throw new AppError(
              "Interrupted build cleanup is still pending. It will be retried when the server is reachable.",
              503,
              "DEPLOYMENT_RECOVERY_PENDING",
            );
        }
      },
      {
        onFinished: async () => {
          await settleDeployment();
        },
      },
    );
    if (recovered) {
      const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
      if (session && !session.finishedAt)
        await repos.deployment.acknowledgeBuildExecutionFinished(session.id);
    }
    return recovered;
  }

  if (["queued", "building", "deploying"].includes(dep.status)) return false;

  return (
    (await tryWithCloudWorkspaceActivity(
      project.workspaceId,
      async () => {
        const [current, owner] = await Promise.all([
          repos.deployment.findById(dep.id),
          repos.project.findById(project.id),
        ]);
        if (
          !current ||
          !owner ||
          owner.workspaceId !== project.workspaceId ||
          !matchesDestination(current, owner) ||
          ["queued", "building", "deploying"].includes(current.status)
        )
          return false;
        const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
        if (!session || session.finishedAt) return true;

        const keep =
          (current.meta as { cancellation?: { keepProvisioned?: boolean } } | null)?.cancellation
            ?.keepProvisioned === true;
        if (!keep && (current.status === "cancelled" || current.status === "failed")) {
          const manifest = await collectDeploymentManifest(current, owner, {
            protectRetained: true,
          });
          const cleanup = await executeCleanup(manifest);
          if (cleanup.failed.length)
            throw new AppError(
              "The interrupted deployment could not finish cleanup. Retry cancellation when the server is reachable.",
              503,
              "DEPLOYMENT_RECOVERY_PENDING",
            );
        }
        await repos.deployment.acknowledgeBuildExecutionFinished(session.id);
        return true;
      },
      `project:${project.id}`,
    )) === true
  );
}
