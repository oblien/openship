import { repos, type Deployment, type Project } from "@repo/db";
import { deriveProjectDeployTarget, type DeployTarget } from "@repo/core";

/**
 * Resolve the target represented by a project and its active deployment.
 *
 * Durable project bindings decide the target exposed to callers and the next
 * deployment. An active deployment snapshot may refine the server identity when
 * both sources agree that this is a server target, and it is the legacy fallback
 * only when no durable binding exists. This prevents stale metadata from turning
 * a Cloud-bound project back into a server project in the dashboard/API.
 */
export function readDeployMeta(
  project: Pick<Project, "cloudWorkspaceId" | "serverId" | "activeDeploymentId">,
  activeDeployment: Deployment | null | undefined,
): { deployTarget: DeployTarget | null; serverId: string | null } {
  const meta = (activeDeployment?.meta ?? null) as {
    deployTarget?: unknown;
    serverId?: string;
  } | null;
  const snapshotTarget: DeployTarget | null =
    meta?.deployTarget === "local" ||
    meta?.deployTarget === "server" ||
    meta?.deployTarget === "cloud"
      ? meta.deployTarget
      : null;

  if (project.cloudWorkspaceId) {
    return { deployTarget: "cloud", serverId: null };
  }

  if (project.serverId) {
    return {
      deployTarget: "server",
      serverId:
        activeDeployment && snapshotTarget === "server"
          ? (meta?.serverId ?? project.serverId)
          : project.serverId,
    };
  }

  if (activeDeployment && snapshotTarget) {
    if (snapshotTarget !== "server") {
      return { deployTarget: snapshotTarget, serverId: null };
    }
    return {
      deployTarget: "server",
      serverId: meta?.serverId ?? null,
    };
  }

  // Legacy active snapshots sometimes stamped serverId without deployTarget.
  // That still identifies the live physical target more precisely than today's
  // mutable project binding.
  if (activeDeployment && meta?.serverId) {
    return { deployTarget: "server", serverId: meta.serverId };
  }

  // A never-deployed project with no binding has no target yet. Choosing local
  // here would silently pick a destination on the operator's behalf.
  if (!project.activeDeploymentId) {
    return { deployTarget: null, serverId: null };
  }

  const deployTarget = deriveProjectDeployTarget({
    cloudWorkspaceId: null,
    serverId: null,
  });

  // A cloud target and a server id must never be emitted together. The server
  // may be stale state from before a move to cloud or from an old snapshot.
  return {
    deployTarget,
    serverId: null,
  };
}

/** Canonical target resolver for callers that do not already hold the active deployment. */
export async function resolveProjectDeployTarget(
  project: Pick<Project, "cloudWorkspaceId" | "serverId" | "activeDeploymentId">,
): Promise<{ deployTarget: DeployTarget | null; serverId: string | null }> {
  const activeDeployment = project.activeDeploymentId
    ? ((await repos.deployment.findById(project.activeDeploymentId)) ?? null)
    : null;
  return readDeployMeta(project, activeDeployment);
}

/**
 * Resolve where the currently active release actually runs.
 *
 * This is intentionally distinct from `resolveProjectDeployTarget`, whose
 * durable project binding represents the destination of the next deploy. Edge
 * repair and other live-runtime operations must prefer the immutable active
 * deployment snapshot or they can mutate a future server after a target edit.
 */
export async function resolveProjectLiveDeployTarget(
  project: Pick<Project, "cloudWorkspaceId" | "serverId" | "activeDeploymentId">,
): Promise<{ deployTarget: DeployTarget | null; serverId: string | null }> {
  if (!project.activeDeploymentId) return { deployTarget: null, serverId: null };
  const active = (await repos.deployment.findById(project.activeDeploymentId)) ?? null;
  const meta = (active?.meta ?? null) as {
    deployTarget?: unknown;
    serverId?: string;
  } | null;

  if (
    meta?.deployTarget === "local" ||
    meta?.deployTarget === "cloud" ||
    meta?.deployTarget === "server"
  ) {
    return meta.deployTarget === "server"
      ? { deployTarget: "server", serverId: meta.serverId ?? project.serverId ?? null }
      : { deployTarget: meta.deployTarget, serverId: null };
  }
  if (meta?.serverId) return { deployTarget: "server", serverId: meta.serverId };

  // Legacy active deployments did not persist target metadata. Only then may
  // the current durable binding stand in for the live target.
  return readDeployMeta(project, active);
}
