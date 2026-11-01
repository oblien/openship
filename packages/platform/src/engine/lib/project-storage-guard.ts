import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import {
  KubernetesApiError,
  kubernetesProjectNamespace,
  type KubernetesObject,
} from "@repo/adapters";
import { openClusterApi } from "./cluster-deployment-target";

/** Called under the project runtime lock, before moving or deleting a project. */
export async function assertProjectStorageEmpty(
  organizationId: string,
  projectId: string,
  clusterId: string,
  options?: { deletingProject?: boolean },
) {
  const runtime = await repos.clusterRuntime.get(organizationId, clusterId);
  if (runtime?.provider === "swarm") {
    // The shared teardown applies the user's keep/wipe choice to manager-local
    // volumes. Retargeting is not a storage migration and must never imply one.
    if (options?.deletingProject) return;
    throw new AppError(
      "Move a Swarm project's data through an explicit migration before changing its cluster.",
      409,
      "CLUSTER_VOLUMES_ATTACHED",
    );
  }
  const connection = await openClusterApi(organizationId, clusterId);
  try {
    const claims = await connection.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/namespaces/${kubernetesProjectNamespace(projectId)}/persistentvolumeclaims`,
      undefined,
      AbortSignal.timeout(30_000),
    );
    if (claims.items.length)
      throw new AppError(
        "This project still has stored files. Move or explicitly delete its volumes before moving or deleting the project.",
        409,
        "CLUSTER_VOLUMES_ATTACHED",
      );
    const deletions = await connection.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/namespaces/${kubernetesProjectNamespace(projectId)}/configmaps?labelSelector=openship.io%2Fvolume-deletion%3Dtrue`,
      undefined,
      AbortSignal.timeout(30_000),
    );
    if (deletions.items.length)
      throw new AppError(
        "Finish the pending file-volume cleanup before moving or deleting this project.",
        409,
        "CLUSTER_VOLUMES_ATTACHED",
      );
  } catch (error) {
    if (!(error instanceof KubernetesApiError) || error.statusCode !== 404) throw error;
  } finally {
    await connection.api.dispose();
  }
}
