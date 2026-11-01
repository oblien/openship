import type { Deployment } from "@repo/db";
import { isMutableImageRef } from "@repo/core";

export { isMutableImageRef } from "@repo/core";

export function deploymentImagePullPolicy(
  dep: Pick<Deployment, "trigger">,
  forcePullImages?: boolean,
  imageRef?: string,
): { force: boolean; refreshMutableTag: boolean } {
  // A rollback replays its artifacts even if an old snapshot retained a pull hint.
  if (dep.trigger === "rollback") return { force: false, refreshMutableTag: false };
  return {
    force: dep.trigger === "update" || forcePullImages === true,
    refreshMutableTag:
      (dep.trigger === "manual" || dep.trigger === "redeploy") &&
      !!imageRef &&
      isMutableImageRef(imageRef),
  };
}

/**
 * Whether a deploy re-pulls its image instead of reusing one already present on the host.
 * Shared by the single-image pipeline (Docker and the cluster builder) and the Compose path.
 *
 * Manual deploys and redeploys request a registry tag refresh; the runtime proves
 * registry provenance before pulling, preserving local artifacts. Webhook deploys
 * keep pull-if-missing unless explicitly forced. Rollbacks always replay their pins.
 */
export function deploymentForcesImagePull(
  dep: Pick<Deployment, "trigger">,
  forcePullImages?: boolean,
  imageRef?: string,
): boolean {
  const policy = deploymentImagePullPolicy(dep, forcePullImages, imageRef);
  return policy.force || policy.refreshMutableTag;
}
