import type { Deployment } from "@repo/db";

/** A ref that can move under us: anything not pinned to a digest. */
export function isMutableImageRef(ref: string): boolean {
  return !/@sha256:[a-f0-9]{64}$/.test(ref);
}

/**
 * Whether a deploy re-pulls its image instead of reusing one already present on the host.
 * Shared by the single-image pipeline (Docker and the cluster builder) and the Compose path.
 *
 * A manual deploy of a mutable ref (`:edge`, `:latest`, `:1`) re-pulls as well: the
 * pull-if-missing shortcut otherwise ships whatever tag the host cached, and the only way
 * to roll a private image forward was `docker pull` over SSH (private registries are
 * invisible to update detection, so the `update` trigger never fires for them).
 * Webhook and rollback deploys of an already-present image stay pull-if-missing.
 */
export function deploymentForcesImagePull(
  dep: Pick<Deployment, "trigger">,
  forcePullImages?: boolean,
  imageRef?: string,
): boolean {
  if (dep.trigger === "update" || forcePullImages === true) return true;
  return dep.trigger === "manual" && imageRef !== undefined && isMutableImageRef(imageRef);
}
