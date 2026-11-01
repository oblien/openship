import { repos, type Deployment, type Project } from "@repo/db";
import { env } from "../../config/env";
import { planBuildConcurrency } from "../../lib/plan-guard";

export interface CloudBuildQueueStatus {
  /** One-based workspace FIFO position; null when dispatch raced this read. */
  position: number | null;
  reason: "concurrency" | "resources" | "server";
  /** null preserves plans with no simultaneous-build cap. */
  simultaneousBuilds: number | null;
  activeBuilds: number;
  workspaceId: string;
}

/** Advisory read projection only. Admission remains owned by cloud-build-queue.
 * Dispatchers may persist cloudBuildQueueReason for resource/server waits. */
export async function getCloudBuildQueueStatus(
  project: Project,
  dep: Deployment,
): Promise<CloudBuildQueueStatus | null> {
  const meta = dep.meta as Record<string, unknown> | null;
  if (
    !env.CLOUD_MODE ||
    !project.workspaceId ||
    dep.status !== "queued" ||
    meta?.cloudBuildRequested !== true ||
    project.id !== dep.projectId ||
    project.organizationId !== dep.organizationId
  )
    return null;

  const [simultaneousBuilds, legacyBuilds, reservations, position] = await Promise.all([
    planBuildConcurrency(dep.organizationId, project.workspaceId),
    repos.deployment.countActiveCloudBuilds(project.workspaceId, dep.organizationId),
    repos.cloudBuildActivity.listReservations(project.workspaceId, dep.organizationId),
    repos.deployment.getCloudBuildQueuePosition(dep.id, dep.organizationId),
  ]);
  // Activity-backed leases are excluded by the legacy count. Lifecycle-only
  // activities (resources=null) hold no simultaneous-build slot.
  const activeBuilds = legacyBuilds + reservations.filter((row) => row.resources !== null).length;
  const reason =
    simultaneousBuilds !== null && activeBuilds >= simultaneousBuilds
      ? "concurrency"
      : meta.cloudBuildQueueReason === "resources" || meta.cloudBuildQueueReason === "concurrency"
        ? meta.cloudBuildQueueReason
        : "server";
  return { position, reason, simultaneousBuilds, activeBuilds, workspaceId: project.workspaceId };
}
