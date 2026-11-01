import { repos, type Deployment, type Project } from "@repo/db";
import { deploymentBelongsToProject } from "@repo/core";
import { activeDeploymentForProject } from "../../lib/active-deployment";
import { isArtifactRef, usableRef } from "../../lib/container-ref";
import { resolveRollbackWindow, type RollbackWindowProject } from "./release-retention";
import { artifactReferences, deploymentArtifacts, hasRetryableBuild } from "./deployment-artifacts";

type RetentionProject = Pick<Project, "id" | "organizationId" | "activeDeploymentId"> & RollbackWindowProject;
type ServiceArtifact = {
  imageRef: string | null;
  containerId?: string | null;
  serviceId?: string;
  serviceName?: string | null;
};

/** Resolve carried images the same way for cleanup and rollback. A skipped
 * service may have no image on its row even though its earlier image is live. */
export async function effectiveServiceArtifacts(
  deployment: Deployment,
  rows: ServiceArtifact[],
): Promise<ServiceArtifact[]> {
  if (!rows.some((row) => !row.imageRef && row.serviceId)) return rows;
  const asOf = await repos.serviceDeployment.effectiveImagesAsOf(
    deployment.projectId,
    deployment.createdAt,
  );
  return rows.map((row) => {
    const previous = row.serviceId ? asOf.get(row.serviceId) : undefined;
    return {
      ...row,
      serviceName: row.serviceName ?? previous?.serviceName ?? null,
      imageRef: row.imageRef ?? previous?.imageRef ?? null,
    };
  });
}

export interface RetentionLoaders {
  listForRetention?: (projectId: string) => Promise<Deployment[]>;
  findById?: (id: string) => Promise<Deployment | undefined>;
  listByDeployment?: (depId: string) => Promise<ServiceArtifact[]>;
}

/** One selection for retention, image GC, and deployment cleanup. The window
 * counts past successful releases; active and pinned releases are extra. Read
 * failures propagate: an incomplete inventory must never authorize deletion. */
export async function retainedArtifacts(project: RetentionProject, loaders: RetentionLoaders = {}) {
  const list = loaders.listForRetention ?? repos.deployment.listForRetention;
  const find = loaders.findById ?? repos.deployment.findById;
  const listServices = loaders.listByDeployment ?? repos.service.listByDeployment;
  const window = await resolveRollbackWindow(project);
  const candidates = await list(project.id);
  const retained: Deployment[] = [];
  const overflow: Deployment[] = [];
  let pastReleases = 0;
  let newestSettledBuildSeen = false;
  let retryableDeploymentId: string | undefined;
  for (const dep of candidates) {
    if (!deploymentBelongsToProject(project, dep)) continue;
    // One failed completed build is retryable, until a newer release succeeds
    // or a newer completed attempt fails. It never consumes rollback history.
    const retryable = hasRetryableBuild(dep) && !newestSettledBuildSeen;
    if (retryable) retryableDeploymentId = dep.id;
    if (hasRetryableBuild(dep) || dep.status === "ready" || dep.status === "partial_failure")
      newestSettledBuildSeen = true;
    const buildingArtifact = ["building", "deploying"].includes(dep.status) && !!deploymentArtifacts(dep.meta);
    // A disconnected worker may already have activated this release. Preserve
    // it until host verification settles the outcome, without spending history.
    if (dep.id === project.activeDeploymentId || dep.pinned || dep.status === "reconciling" || retryable || buildingArtifact) {
      retained.push(dep);
    } else if ((dep.status === "ready" || dep.status === "partial_failure") && pastReleases < window) {
      retained.push(dep);
      pastReleases += 1;
    } else if (dep.artifactRetainedAt) {
      overflow.push(dep);
    }
  }
  if (project.activeDeploymentId && !retained.some((dep) => dep.id === project.activeDeploymentId)) {
    const active = activeDeploymentForProject(project, await find(project.activeDeploymentId));
    if (active) retained.push(active);
  }

  return { ...await retainedArtifactReferences(retained, listServices), retained, overflow,
    ...(retryableDeploymentId ? { retryableDeploymentId } : {}),
  };
}

/** Shared protection inventory for count-based and storage-pressure cleanup. */
export async function retainedArtifactReferences(
  retained: Deployment[],
  listServices: NonNullable<RetentionLoaders["listByDeployment"]> = repos.service.listByDeployment,
) {
  const images = new Set<string>();
  const containers = new Set<string>();
  const services = new Map<string, ServiceArtifact[]>();
  for (const dep of retained) {
    const receipt = deploymentArtifacts(dep.meta);
    if (receipt) for (const image of artifactReferences(receipt)) images.add(image);
    for (const role of dep.roleContainers ?? []) {
      const container = usableRef(role.containerId);
      if (container) containers.add(container);
    }
    const serviceRows = await effectiveServiceArtifacts(dep, await listServices(dep.id));
    services.set(dep.id, serviceRows);
    for (const artifact of [dep, ...serviceRows]) {
      const image = usableRef(artifact.imageRef);
      const container = usableRef(artifact.containerId);
      if (image) images.add(image);
      if (container) containers.add(container);
      if (isArtifactRef(container)) images.add(container!);
    }
  }
  return { images, containers, services };
}

export async function computeKeepSet(project: RetentionProject, loaders?: RetentionLoaders): Promise<Set<string>> {
  return (await retainedArtifacts(project, loaders)).images;
}
