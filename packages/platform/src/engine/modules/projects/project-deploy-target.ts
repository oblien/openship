import { activeDeploymentForProject, findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import type { Deployment, Project } from "@repo/db";
import { deriveProjectDeployTarget, type DeployTarget } from "@repo/core";
import type { DeploymentMeta } from "../../lib/deployment-runtime";

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
  project: Pick<Project, "activeDeploymentId"> & Partial<Pick<Project, "serverId" | "clusterId" | "workspaceId">>,
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

  if (project.workspaceId) {
    return { deployTarget: "cloud", serverId: project.serverId ?? null };
  }
  if (project.clusterId) return { deployTarget: "cluster", serverId: null };

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
    workspaceId: null,
    serverId: null,
  });

  // This unbound fallback has no execution server to emit.
  return {
    deployTarget,
    serverId: null,
  };
}

/** Canonical target resolver for callers that do not already hold the active deployment. */
export async function resolveProjectDeployTarget(
  project: Pick<Project, "id" | "organizationId" | "serverId" | "activeDeploymentId"> & Partial<Pick<Project, "clusterId" | "workspaceId">>,
): Promise<{ deployTarget: DeployTarget | null; serverId: string | null }> {
  const activeDeployment = project.activeDeploymentId
    ? ((await findActiveDeployment(project)) ?? null)
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
  project: Pick<Project, "id" | "organizationId" | "activeDeploymentId"> & Partial<Pick<Project, "serverId" | "clusterId" | "workspaceId">>,
  deployment?: Deployment | null,
): Promise<{ deployTarget: DeployTarget | null; serverId: string | null }> {
  if (!project.activeDeploymentId) return { deployTarget: null, serverId: null };
  const active = deployment === undefined
    ? await findActiveDeployment(project)
    : activeDeploymentForProject(project, deployment);
  if (!active) return { deployTarget: null, serverId: null };
  const meta = (active?.meta ?? null) as {
    deployTarget?: unknown;
    serverId?: string;
    clusterId?: string;
    clusterRuntimeId?: string;
    managedServer?: unknown;
    managedWorkspaceId?: string;
  } | null;

  if (meta?.clusterId) {
    const { requireClusterDeploymentTarget } = await import("../../lib/cluster-deployment-target");
    const { runtime } = await requireClusterDeploymentTarget(project.organizationId, meta.clusterId, meta.clusterRuntimeId);
    return { deployTarget: "cluster", serverId: runtime.plan.hosts.find(host => host.role === "server")!.serverId };
  }

  // Docker's durable workspace is also stamped on the release. The platform
  // resolver validates its project/namespace binding before any provider write.
  if (meta?.managedServer || meta?.managedWorkspaceId) return { deployTarget: "cloud", serverId: meta.managedWorkspaceId ? meta.serverId ?? project.serverId ?? null : null };

  if (
    meta?.deployTarget === "local" ||
    meta?.deployTarget === "cloud" ||
    meta?.deployTarget === "cluster" ||
    meta?.deployTarget === "server"
  ) {
    return meta.deployTarget === "server"
      ? { deployTarget: "server", serverId: meta.serverId ?? project.serverId ?? null }
      : { deployTarget: meta.deployTarget, serverId: null };
  }
  if (meta?.serverId) return { deployTarget: "server", serverId: meta.serverId };

  // Legacy active deployments did not persist target metadata. Prefer their
  // durable binding, then use the same host default as runtime resolution. A
  // Cloud deployment with neither field must not become a local server here.
  if (project.workspaceId || project.serverId || project.clusterId) {
    return readDeployMeta(project, active);
  }
  const [{ resolveEffectiveTarget }, { platform }] = await Promise.all([
    import("../../lib/deployment-runtime"),
    import("../../lib/platform-config"),
  ]);
  return {
    deployTarget: resolveEffectiveTarget(platform().target, (active.meta ?? {}) as DeploymentMeta),
    serverId: null,
  };
}
