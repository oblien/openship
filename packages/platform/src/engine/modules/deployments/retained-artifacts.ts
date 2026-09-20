import { repos, type Deployment, type Project } from "@repo/db";
import { deploymentBelongsToProject } from "@repo/core";
import { activeDeploymentForProject } from "../../lib/active-deployment";
import { isArtifactRef, usableRef } from "../../lib/container-ref";
import { resolveRollbackWindow, type RollbackWindowProject } from "./release-retention";

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
  for (const dep of candidates) {
    if (!deploymentBelongsToProject(project, dep)) continue;
    // A disconnected worker may already have activated this release. Preserve
    // it until host verification settles the outcome, without spending history.
    if (dep.id === project.activeDeploymentId || dep.pinned || dep.status === "reconciling") {
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

  const images = new Set<string>();
  const containers = new Set<string>();
  for (const dep of retained) {
    const artifacts = [dep, ...await effectiveServiceArtifacts(dep, await listServices(dep.id))];
    for (const artifact of artifacts) {
      const image = usableRef(artifact.imageRef);
      const container = usableRef(artifact.containerId);
      if (image) images.add(image);
      if (container) containers.add(container);
      // Static releases use their document root as the container id.
      if (isArtifactRef(container)) images.add(container!);
    }
  }
  return { images, containers, retained, overflow };
}

export async function computeKeepSet(project: RetentionProject, loaders?: RetentionLoaders): Promise<Set<string>> {
  return (await retainedArtifacts(project, loaders)).images;
}
