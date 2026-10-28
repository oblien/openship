import {
  isFullCommitSha,
  isReleaseProvider,
  releaseArtifactKind,
  ValidationError,
  type ComposeAdvanced,
} from "@repo/core";
import type { CreateDeploymentResult, UpdateRuntimeInput } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { findActiveDeployment } from "../../lib/active-deployment";
import { resolveSubAppImages, resolveSubAppRecipe, serviceKind } from "../../lib/deployable-service";
import { resolveSnapshotRuntimeMode } from "../../lib/deployment-runtime";
import { assertNotControlPlane, assertResourceInOrg } from "../../lib/resource-access";
import {
  buildConfigSnapshot,
  resolveSnapshotTarget,
  triggerDeployment,
  type DeploymentConfigSnapshot,
  type DeploymentTriggerInput,
} from "../deployments/build.service";
import { resolveServicePipelineMode } from "../deployments/build-pipeline";
import { projectToClass } from "../deployments/deployment-class";
import { assertExactServiceTargets } from "../deployments/exact-service-targets";
import { isMutableImageRef } from "../deployments/image-pull-policy";
import { snapshotNeedsProjectSource } from "../deployments/pinned-artifacts";
import { projectServicesToDeployableServices } from "../deployments/compose/project-services";
import type { SecurityUpdateApproval } from "./security-refresh-guard";

const hasMutableImage = (...refs: (string | null | undefined)[]) =>
  refs.some((ref) => !!ref && isMutableImageRef(ref));

/** A rebuild is required before the current source revision can be trusted. */
export class RuntimeSourceRedeployRequired extends ValidationError {}

/** Shared read-only preflight for advisory actions and the normal runtime refresh. */
export async function planProjectRuntimeUpdate(
  ctx: ExecutionContext,
  projectId: string,
  input: UpdateRuntimeInput = {},
  approval?: SecurityUpdateApproval,
): Promise<{ deploymentId: string; input: DeploymentTriggerInput }> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  assertNotControlPlane(project);
  const active = await findActiveDeployment(project);
  if (!active) throw new ValidationError("Deploy this project before updating its runtime.");
  if (approval && active.id !== approval.deploymentId)
    throw new ValidationError("The active deployment changed. Check the advisory again.");
  const meta = (active.meta ?? {}) as Partial<DeploymentConfigSnapshot>;

  const services = await repos.service.listByProject(projectId);
  if (input.serviceIds) {
    try {
      assertExactServiceTargets(services, input.serviceIds, "Runtime update");
    } catch (error) {
      throw new ValidationError((error as Error).message);
    }
  }
  const selected = services.filter(
    (service) => service.enabled && (!input.serviceIds || input.serviceIds.includes(service.id)),
  );
  const target = await resolveSnapshotTarget(project);
  const snapshot = {
    ...buildConfigSnapshot(project, active.branch ?? undefined),
    ...target,
    ...(input.serviceIds && { targetServiceIds: input.serviceIds }),
  };
  const { useServicePipeline: usesServices } = await resolveServicePipelineMode(project, snapshot);
  if (
    usesServices &&
    !input.serviceIds &&
    isReleaseProvider(project.gitProvider) &&
    releaseArtifactKind(project.releaseSource) === "image"
  ) {
    // The service pipeline owns saved service rows, not the standalone release
    // image. An all-project update here would silently leave that main app old.
    throw new ValidationError(
      "The main release image and added services cannot be updated together through this pipeline. Select a specific service to update, or change the application configuration before updating the main image.",
    );
  }
  const deploymentClass = projectToClass(project);
  if (
    !usesServices &&
    (target.runtimeMode ?? resolveSnapshotRuntimeMode(target, target.deployTarget ?? "local")) !==
      "docker"
  ) {
    throw new ValidationError(
      "Base-image refresh requires a Docker build or application image. Update bare runtimes directly on their server.",
    );
  }

  if (
    usesServices &&
    selected.some((service) => (service.advanced as ComposeAdvanced | null)?.build)
  ) {
    throw new RuntimeSourceRedeployRequired(
      "Inline template build contexts do not retain a deployed source revision. Use Redeploy to rebuild that template.",
    );
  }
  const sourceServices = usesServices
    ? selected.filter((service) =>
        snapshotNeedsProjectSource(snapshot, projectServicesToDeployableServices([service])),
      )
    : [];
  const hasSourceBuild = usesServices
    ? sourceServices.length > 0
    : snapshot.build === "buildpack" ||
      snapshot.build === "dockerfile" ||
      snapshot.build === "static";
  if (hasSourceBuild && deploymentClass.source !== "git") {
    throw new RuntimeSourceRedeployRequired(
      "Runtime updates need a deployed Git revision to keep application code unchanged. Use Redeploy for local or uploaded source.",
    );
  }
  // Image-only scopes need registry images, even if their project also has a
  // repository. A retained Git revision is required only when rebuilding source.
  if (hasSourceBuild && !isFullCommitSha(active.commitSha)) {
    throw new RuntimeSourceRedeployRequired(
      "The active deployment has no retained Git revision. Redeploy it before updating its runtime.",
    );
  }
  if (
    hasSourceBuild &&
    (active.trigger === "rollback" ||
      meta.adopt ||
      (!usesServices && (meta.handoverAppImage || meta.refreshAppDeploymentId)))
  ) {
    throw new RuntimeSourceRedeployRequired(
      "Runtime update cannot confirm the deployed source revision of a replayed artifact. Redeploy the source app explicitly before updating its runtime.",
    );
  }
  if (usesServices && hasSourceBuild) {
    const activeRows = await repos.service.listByDeployment(active.id);
    if (
      sourceServices.some(
        (service) =>
          !activeRows.some(
            (row) => row.serviceId === service.id && row.status === "success" && !!row.imageRef,
          ) ||
          (!!meta.targetServiceIds?.length && !meta.targetServiceIds.includes(service.id)) ||
          !!meta.handoverImages?.[service.name] ||
          meta.refreshServiceIds?.includes(service.id),
      )
    ) {
      // Carried services retain an earlier image even when the project advances
      // to another commit. There is no per-service source revision to replay.
      throw new RuntimeSourceRedeployRequired(
        "Runtime update cannot confirm the deployed revision for source services carried forward from another deployment. Redeploy those services explicitly before updating their runtime, or select services built by the active deployment.",
      );
    }
  }

  const canRefresh = usesServices
    ? selected.some((service) => {
        if (serviceKind(service) === "monorepo" && !service.image) {
          const recipe = resolveSubAppRecipe(service, snapshot);
          const images = resolveSubAppImages(service, snapshot);
          return (
            recipe.framework === "docker" ||
            hasMutableImage(images.runtimeImage, images.buildImage)
          );
        }
        return !!service.build || !!service.dockerfile || hasMutableImage(service.image);
      })
    : // A custom Dockerfile owns its FROMs; BuildKit resolves them during the
      // build. Generated recipes can refresh either stage while pins stay exact.
      hasSourceBuild
      ? snapshot.build === "dockerfile" ||
        hasMutableImage(snapshot.runtimeImage, snapshot.buildImage)
      : // Container-release templates are tag-only (renderReleaseImage rejects
        // digests). The successful deployment's frozen digest is for rollback,
        // not a configured pin; triggerDeployment resolves the retained tag.
        (isReleaseProvider(project.gitProvider) &&
          releaseArtifactKind(project.releaseSource) === "image") ||
        hasMutableImage(meta.releaseImageRef);
  if (!canRefresh) {
    throw new ValidationError(
      "No mutable runtime images can be updated. Digest-pinned images stay fixed; choose a newer image or digest in configuration first.",
    );
  }

  const releaseVersion =
    meta.releaseTag ?? meta.releaseVersion ?? active.releaseVersion ?? undefined;
  if (
    isReleaseProvider(project.gitProvider) &&
    (releaseArtifactKind(project.releaseSource) !== "image" || !releaseVersion)
  ) {
    throw new ValidationError(
      "Runtime updates require a retained container release version. Use Update or Redeploy for archive releases.",
    );
  }
  return {
    deploymentId: active.id,
    input: {
      projectId,
      environment: active.environment,
      branch: active.branch ?? undefined,
      commitSha: active.commitSha ?? undefined,
      commitMessage: active.commitMessage ?? undefined,
      ...(isReleaseProvider(project.gitProvider) && { releaseVersion }),
      trigger: "update",
      forcePullImages: true,
      ...(approval && { securityApproval: approval }),
      ...(input.serviceIds
        ? { serviceIds: input.serviceIds, strictServiceScope: true }
        : { forceAll: true }),
    },
  };
}

/** Refresh runtime artifacts through the normal deployment funnel, keeping code fixed. */
export async function updateProjectRuntime(
  ctx: ExecutionContext,
  projectId: string,
  input: UpdateRuntimeInput = {},
  approval?: SecurityUpdateApproval,
): Promise<CreateDeploymentResult> {
  const plan = await planProjectRuntimeUpdate(ctx, projectId, input, approval);
  const result = await triggerDeployment(ctx, plan.input);
  return result.awaitingActions
    ? {
        awaiting_actions: true,
        action_request_id: result.awaitingActions.id,
        project_id: result.awaitingActions.projectId,
        skipped: true,
      }
    : {
        project_id: projectId,
        deployment_id: result.deployment.id,
        ...(result.skipped !== undefined && { skipped: result.skipped }),
      };
}
