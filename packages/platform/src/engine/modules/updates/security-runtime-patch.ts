import { createHash } from "node:crypto";
import {
  getDockerBuildRecipe,
  getDockerRuntimeProbe,
  satisfiesRange,
  securityRuntimeImages,
  ValidationError,
  type SecurityAdvisory,
} from "@repo/core";
import type { ProjectSecurityResult } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import { resolveLatestImageDigest } from "../../lib/image-registry";
import { buildConfigSnapshot } from "../deployments/build.service";
import { resolveServicePipelineMode } from "../deployments/build-pipeline";
import type { SecurityInventory } from "./security-inventory";

export type SecurityRuntimePatch = NonNullable<
  ProjectSecurityResult["findings"][number]["runtimePatch"]
>;
export class RuntimeImageChangeRequired extends ValidationError {}

/** A version-changing manual patch is distinct from repulling a configured tag. */
export async function planSecurityRuntimePatch(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string | null,
  advisory: SecurityAdvisory,
  inventory: SecurityInventory,
  refresh = false,
): Promise<SecurityRuntimePatch | null> {
  const affected = advisory.targets.flatMap((target) => {
    if (target.kind !== "runtime" || !target.fixed) return [];
    return inventory.runtimes
      .filter(
        (runtime) =>
          runtime.serviceId === serviceId &&
          runtime.runtime === target.runtime &&
          satisfiesRange(runtime.version, target.affected),
      )
      .map((runtime) => ({ runtime, affected: target.affected, fixed: target.fixed! }));
  });
  if (!affected.length) return null;
  // Other runtime policies retain their existing refresh behavior. Selecting
  // versions for their images needs the corresponding toolchain's own policy.
  if (!affected.some(({ runtime }) => runtime.runtime === "node" || runtime.runtime === "bun"))
    return null;
  // Application images own their embedded interpreters. Their existing-tag
  // replacement check remains receipt-based; never invent a vendor's version.
  if (inventory.images.some((image) => image.serviceId === serviceId && image.role === "image"))
    return null;

  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const snapshot = buildConfigSnapshot(project);
  const { useServicePipeline } = await resolveServicePipelineMode(project, snapshot);
  const selected = affected[0]!;
  const runtime = selected.runtime.runtime;
  if (
    serviceId ||
    useServicePipeline ||
    affected.length !== 1 ||
    snapshot.build !== "buildpack" ||
    getDockerBuildRecipe(snapshot.framework) !== "generic" ||
    getDockerRuntimeProbe(snapshot.framework, snapshot.packageManager) !== runtime ||
    (runtime !== "node" && runtime !== "bun")
  )
    throw new RuntimeImageChangeRequired(
      "This runtime is controlled by the service configuration or Dockerfile. Select a patched runtime there, then redeploy. Refreshing the build image alone cannot patch it.",
    );
  const images = securityRuntimeImages({
    runtime,
    currentVersion: selected.runtime.version,
    fixed: selected.fixed,
    buildImage: snapshot.buildImage,
    runtimeImage: snapshot.runtimeImage,
  });
  if (!images || satisfiesRange(images.version, selected.affected))
    throw new RuntimeImageChangeRequired(
      "A compatible patched version could not be selected for the configured images. Update the runtime configuration or Dockerfile before redeploying.",
    );
  // The signed range authorizes the version, not arbitrary registry names.
  // Only official images with the same distribution are produced by the planner.
  for (const image of new Set([images.buildImage, images.runtimeImage])) {
    if (!(await resolveLatestImageDigest(image, { refresh })))
      throw new ValidationError(
        `The registry could not confirm the patched image ${image}. Check again before applying the patch.`,
      );
  }
  return {
    reviewId: createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          deploymentId: inventory.deploymentId,
          advisoryId: advisory.id,
          revision: advisory.revision,
          // Bind the resulting configuration. Billing/admission retries can reuse
          // the review after its image selections have already been saved.
          snapshot: buildConfigSnapshot({
            ...project,
            buildImage: images.buildImage,
            runtimeImage: images.runtimeImage,
          }),
          images,
          currentVersion: selected.runtime.version,
        }),
      )
      .digest("hex"),
    runtime,
    currentVersion: selected.runtime.version,
    targetVersion: images.version,
    buildImage: images.buildImage,
    runtimeImage: images.runtimeImage,
  };
}
