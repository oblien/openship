/**
 * What a single-deployment teardown must NOT destroy.
 *
 * D3: `collectDeploymentManifest` enumerated a deployment's containers and images
 * with no keep set at all, and compose carries an unchanged service's
 * `containerId` / `imageRef` VERBATIM onto the next release's row
 * (`compose/deploy.service.ts` — the `carried` seam). So the rejected release's
 * manifest names the predecessor's LIVE container and the image every retained
 * release still needs — and reject destroys them microseconds after asking for
 * that predecessor to be restored.
 *
 * Images reuse `computeKeepSet`, so "what is still restorable" keeps exactly one
 * definition shared with the image GC, the retention prune and the deploy-time
 * supersede check. Containers are narrower on purpose: only ONE release's
 * containers are actually running, so the set is the active release plus the one
 * a reject is restoring. Anything a retained-but-not-active release references is
 * either that same live container (carried forward, hence already covered) or a
 * dead id whose cleanup is the point.
 */

import { repos, type Deployment, type Project } from "@repo/db";
import { computeKeepSet } from "../deployments/image-gc";
import type { RollbackWindowProject } from "../deployments/release-retention";
import { usableRef } from "../deployments/rollback/restore-plan";

export interface CleanupKeepSet {
  /** Image refs a retained release still needs. */
  images: Set<string>;
  /** Container ids (and static release dirs) belonging to a live release. */
  containers: Set<string>;
}

export interface CleanupKeepSetOpts {
  /**
   * The deployment being torn down. Hidden from the keep set so its OWN
   * artifacts stay removable — without this the release we are deleting keeps
   * itself alive, and a reject would leak every image it ever built.
   */
  excludeDeploymentId?: string | null;
  /**
   * A release that must survive even if it is not (yet) the active one. Reject
   * passes the predecessor it just asked to restore: the restore only ENQUEUES a
   * deploy, so `project.activeDeploymentId` may still point at the deployment
   * being rejected when this runs.
   */
  alsoProtectDeploymentId?: string | null;
}

export async function computeCleanupKeepSet(
  project: Pick<Project, "id" | "activeDeploymentId"> & RollbackWindowProject,
  opts: CleanupKeepSetOpts = {},
): Promise<CleanupKeepSet> {
  const excludeId = opts.excludeDeploymentId ?? null;
  const protectId = opts.alsoProtectDeploymentId ?? null;

  // When we're tearing down the release that is still flagged active, the
  // release being restored takes its place — otherwise `computeKeepSet` would
  // spend the "active" slot on a deployment we're about to delete, and the
  // predecessor would only survive if it happened to fall inside the window.
  const effectiveActiveId =
    project.activeDeploymentId && project.activeDeploymentId === excludeId
      ? protectId
      : project.activeDeploymentId;

  const images = await computeKeepSet(
    { ...project, activeDeploymentId: effectiveActiveId },
    excludeId
      ? {
          listReadyOrderedDesc: (id) =>
            repos.deployment
              .listReadyOrderedDesc(id)
              .then((rows) => rows.filter((d) => d.id !== excludeId)),
          findById: (id) => (id === excludeId ? Promise.resolve(undefined) : repos.deployment.findById(id)),
        }
      : undefined,
  );

  const live = new Set([effectiveActiveId, protectId].filter((id): id is string => !!id && id !== excludeId));

  const containers = new Set<string>();
  for (const depId of live) {
    const dep: Deployment | undefined = await repos.deployment.findById(depId).catch(() => undefined);
    const own = usableRef(dep?.containerId);
    if (own) containers.add(own);

    const rows = await repos.service.listByDeployment(depId).catch(() => []);
    for (const row of rows) {
      const ref = usableRef(row.containerId);
      if (ref) containers.add(ref);
      // A protected release still needs its images even when it never reached
      // `ready` (a partial-failure deploy is rejectable, and its predecessor may
      // sit outside the ready list computeKeepSet walks).
      if (row.imageRef) images.add(row.imageRef);
    }
    if (dep?.imageRef) images.add(dep.imageRef);
  }

  return { images, containers };
}
