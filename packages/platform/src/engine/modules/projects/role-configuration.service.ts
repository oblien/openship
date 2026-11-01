import { isDeepStrictEqual } from "node:util";
import { AppError, ValidationError, parseOpenshipConfig, type StackRole } from "@repo/core";
import { DockerRuntime } from "@repo/adapters";
import { repos, type Deployment, type Project } from "@repo/db";
import type { RuntimeRoleConfigurationInput } from "@repo/contracts";
import type { ExecutionContext } from "@repo/platform";
import {
  listProjectComposeServices,
  primaryAppWithInfrastructure,
  shouldUseProjectServicePipeline,
} from "../deployments/compose/project-services";
import { snapshotToClass } from "../deployments/deployment-class";
import { findActiveDeployment } from "../../lib/active-deployment";
import { assertResourceInOrg, assertNotControlPlane } from "../../lib/resource-access";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import {
  resolveEffectiveTarget,
  resolveSnapshotRuntimeMode,
  withDeploymentRuntime,
} from "../../lib/deployment-runtime";
import { platform } from "../../lib/platform-config";
import { assertGitHubRepoAccess } from "../github/github-access";
import {
  checkNoActiveBuild,
  createQueuedDeployment,
  startBuild,
  type DeploymentConfigSnapshot,
} from "../deployments/build.service";

async function unsupported(
  project: Project,
  active: Deployment | null | undefined,
): Promise<string | null> {
  const meta = active?.meta as DeploymentConfigSnapshot | null;
  if (!active?.containerId || !meta) return "Deploy this app before configuring runtime roles.";
  if (project.disabledAt) return "Resume this app before configuring runtime roles.";
  const unsupportedRuntime = "Runtime role configuration requires a single-app Docker deployment.";
  // Cluster releases are unsupported even when their target metadata conflicts.
  if (meta.clusterId || meta.deployTarget === "cluster") return unsupportedRuntime;
  const base = platform();
  const target = resolveEffectiveTarget(base.target, meta);
  if (
    project.workspaceId ||
    target === "cloud" ||
    target === "cluster" ||
    resolveSnapshotRuntimeMode(meta, target, base) !== "docker" ||
    snapshotToClass(meta).workload === "static"
  )
    return unsupportedRuntime;
  const services = await listProjectComposeServices(project.id);
  if (
    (await shouldUseProjectServicePipeline(project, meta.composeServices, services)) &&
    !primaryAppWithInfrastructure(project, services)
  )
    return unsupportedRuntime;
  return null;
}

export async function getRoleConfiguration(id: string, organizationId: string) {
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", organizationId, id);
  const active = await findActiveDeployment(project);
  const reason = await unsupported(project, active);
  return {
    supported: !reason,
    reason,
    deploymentId: active?.id ?? null,
    updatedAt: project.updatedAt.toISOString(),
    roles: (active?.meta as DeploymentConfigSnapshot | null)?.roles ?? [],
  };
}

/** Ownership and immutable image identity are checked on the selected runtime. */
export async function inspectRoleConfigurationImage(
  runtime: DockerRuntime,
  project: Project,
  active: Deployment,
) {
  const meta = active.meta as DeploymentConfigSnapshot;
  const ownerDeploymentId = meta.webOwnerDeploymentId ?? active.id;
  const id = await runtime.findOwnedDeploymentContainer(active.containerId!, {
    projectId: project.id,
    deploymentId: ownerDeploymentId,
  });
  const detail = id && (await runtime.inspectContainer(id));
  if (!detail || detail.state !== "running" || !/^sha256:[a-f0-9]{64}$/.test(detail.imageId ?? ""))
    throw new AppError(
      "The active app or its image could not be verified. Retry when it is running and reachable.",
      409,
      "ROLE_CONFIGURATION_UNAVAILABLE",
    );
  return { imageId: detail.imageId!, ownerDeploymentId };
}

export async function configureRuntimeRoles(
  ctx: ExecutionContext,
  id: string,
  input: RuntimeRoleConfigurationInput,
) {
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);
  assertNotControlPlane(project);
  await assertGitHubRepoAccess(ctx, { owner: project.gitOwner, repo: project.gitRepo });
  const parsed = parseOpenshipConfig({ roles: input.roles });
  if (parsed.errors.length) throw new ValidationError(parsed.errors.join("; "));
  const roles = JSON.parse(JSON.stringify(parsed.config?.roles ?? [])) as StackRole[];
  const result = await withLiveProjectRuntimeMutation(id, async (live) => {
    assertResourceInOrg(live, "Project", ctx.organizationId, id);
    const inFlight = await repos.deployment.listInFlightByProject(id);
    const prior = inFlight.find((dep) => {
      const snapshot = dep.meta as DeploymentConfigSnapshot | null;
      return (
        snapshot?.roleConfiguration?.sourceDeploymentId === input.expectedDeploymentId &&
        isDeepStrictEqual(snapshot.roles ?? [], roles)
      );
    });
    if (prior) return { deploymentId: prior.id };
    await checkNoActiveBuild(id);
    if (
      live.activeDeploymentId !== input.expectedDeploymentId ||
      live.updatedAt.toISOString() !== input.expectedUpdatedAt
    )
      throw new AppError(
        "The active release or project changed. Reload the role settings.",
        409,
        "ROLE_CONFIGURATION_CHANGED",
      );
    const active = await findActiveDeployment(live);
    const reason = await unsupported(live, active);
    if (reason) throw new ValidationError(reason);
    return withDeploymentRuntime(active!, async (runtime) => {
      if (!(runtime instanceof DockerRuntime) || !runtime.supports("roles"))
        throw new ValidationError("This runtime cannot configure roles.");
      const identity = await inspectRoleConfigurationImage(runtime, live, active!);
      const snapshot: DeploymentConfigSnapshot = {
        ...(active!.meta as DeploymentConfigSnapshot),
        // A roles-only revision must never inherit an earlier service refresh.
        targetServiceIds: undefined,
        refreshServiceIds: undefined,
        strictServiceScope: undefined,
        roles,
        handoverAppImage: identity.imageId,
        refreshAppDeploymentId: active!.id,
        webOwnerDeploymentId: identity.ownerDeploymentId,
        roleConfiguration: {
          sourceDeploymentId: active!.id,
          webContainerId: active!.containerId!,
          webOwnerDeploymentId: identity.ownerDeploymentId,
          imageId: identity.imageId,
        },
      };
      const dep = await createQueuedDeployment({
        projectId: id,
        organizationId: ctx.organizationId,
        branch: active!.branch,
        environment: active!.environment,
        framework: active!.framework ?? snapshot.framework,
        commitSha: active!.commitSha ?? undefined,
        commitMessage: active!.commitMessage ?? undefined,
        trigger: "configuration",
        rollbackStrategy: active!.rollbackStrategy as "snapshot" | "git",
        meta: snapshot,
        envVars: active!.envVars as Record<string, string> | null,
        preservedUrl: active!.url,
        roleChanges: {
          expectedActiveDeploymentId: active!.id,
          expectedProjectUpdatedAt: live.updatedAt,
          roles,
        },
      });
      return { deploymentId: dep.id };
    });
  });
  if (!result) throw new AppError("Project cleanup is pending.", 409, "PROJECT_UNAVAILABLE");
  // The normal worker owns cancellation, history, logs and recovery; release the request lock first.
  await startBuild(result.deploymentId);
  return result;
}
