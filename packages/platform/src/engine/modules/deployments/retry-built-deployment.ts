import { DockerRuntime } from "@repo/adapters";
import { AppError, NotFoundError } from "@repo/core";
import type { Deployment, Project } from "@repo/db";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { withDeploymentRuntime } from "../../lib/deployment-runtime";
import { deploymentArtifacts, hasRetryableBuild } from "./deployment-artifacts";
import { retainedArtifacts } from "./retained-artifacts";
import { withoutPinnedArtifacts, snapshotNeedsProjectSource } from "./pinned-artifacts";
import { hasRedactedFrozenConfiguration } from "./compose/redacted-frozen-env";
import {
  resolveSnapshotTarget,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "./build.service";

const unavailable = () =>
  new AppError(
    "This completed build is no longer available for retry. Use Redeploy to rebuild it.",
    409,
    "DEPLOYMENT_BUILD_UNAVAILABLE",
  );

/** Reuse server-owned image identities; clients cannot supply image refs or targets. */
export async function retryBuiltDeployment(
  ctx: RequestContext,
  target: Deployment,
  project: Project,
) {
  if (
    ctx.organizationId !== target.organizationId ||
    project.organizationId !== ctx.organizationId ||
    target.projectId !== project.id
  )
    throw new NotFoundError("Deployment", target.id);
  const receipt = deploymentArtifacts(target.meta);
  if (!hasRetryableBuild(target) || !receipt) throw unavailable();
  const retained = await retainedArtifacts(project);
  if (retained.retryableDeploymentId !== target.id) throw unavailable();

  const frozen = target.meta as DeploymentConfigSnapshot;
  const currentTarget = await resolveSnapshotTarget(project);
  if (
    (frozen.deployTarget ?? "local") !== (currentTarget.deployTarget ?? "local") ||
    (frozen.serverId ?? null) !== (currentTarget.serverId ?? null) ||
    (frozen.runtimeMode ?? "docker") !== (currentTarget.runtimeMode ?? "docker") ||
    (frozen.managedWorkspaceId && frozen.managedWorkspaceId !== project.workspaceId)
  ) {
    throw new AppError(
      "The project's deployment destination changed. Use Redeploy on the current destination.",
      409,
      "DEPLOYMENT_RETRY_TARGET_CHANGED",
    );
  }
  if (hasRedactedFrozenConfiguration(frozen))
    throw new AppError(
      "This deployment's saved configuration is incomplete. Use Redeploy with the current configuration.",
      409,
      "DEPLOYMENT_RETRY_CONFIGURATION_UNAVAILABLE",
    );

  await withDeploymentRuntime(target, async (runtime) => {
    if (!(runtime instanceof DockerRuntime)) throw unavailable();
    for (const image of receipt.images) {
      // Inspect the immutable ID, never a mutable tag and never a registry pull.
      if (!(await runtime.imageExistsLocally(image.imageId))) throw unavailable();
    }
  });

  const meta = withoutPinnedArtifacts({ ...frozen });
  meta.retryBuildFromDeploymentId = target.id;
  // Retention also needs the build's original owned tag, even though execution
  // uses its immutable ID. Otherwise retiring the failed attempt can untag an
  // image the new attempt still needs.
  meta.completedBuildArtifacts = receipt;
  const serviceImages = receipt.images.filter((image) => image.serviceId);
  let serviceIds: string[] | undefined;
  if (serviceImages.length) {
    serviceIds = serviceImages.map((image) => image.serviceId!);
    meta.handoverImages = Object.fromEntries(
      serviceImages.map((image) => [image.serviceName!, image.imageId]),
    );
    meta.targetServiceIds = serviceIds;
    meta.refreshServiceIds = serviceIds;
    meta.strictServiceScope = true;
  } else {
    meta.handoverAppImage = receipt.images[0]!.imageId;
    meta.refreshAppDeploymentId = target.id;
  }
  // Relative repository mounts are source too. Retry must not silently clone
  // another checkout when the saved artifact is meant to be the complete input.
  if (snapshotNeedsProjectSource(meta))
    throw new AppError(
      "This deployment requires source files as well as its image. Use Redeploy instead.",
      409,
      "DEPLOYMENT_RETRY_SOURCE_REQUIRED",
    );
  const result = await triggerDeployment(ctx, {
    projectId: project.id,
    branch: target.branch,
    commitSha: target.commitSha ?? undefined,
    commitMessage: target.commitMessage ?? undefined,
    environment: target.environment,
    trigger: "retry",
    serviceIds,
    strictServiceScope: !!serviceIds,
    reuseSnapshot: { meta, envVars: target.envVars as Record<string, string> | null },
  });
  if (!result.deployment) throw new Error("Deployment retry did not create an attempt");
  return { success: true, deployment_id: result.deployment.id, project_id: project.id };
}
