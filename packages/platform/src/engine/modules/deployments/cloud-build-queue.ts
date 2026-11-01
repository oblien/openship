import { AppError } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { repos, type Project, type Deployment } from "@repo/db";
import type { PreDeployBackupPolicy } from "../backups/triggers/pre-deploy";
import { env } from "../../config/env";
import { createProvisionLock } from "../../lib/provision-lock";
import {
  planBuildConcurrency,
  PlanUpgradeRequiredError,
  currentPlanTier,
} from "../../lib/plan-guard";
import type { ResourceConfig } from "@repo/adapters";
import { resolveBuildResources } from "../../lib/resources";
import { decideCloudBuildResources } from "../../lib/cloud-build-resources";
import { sampleCloudWorkspaceResources } from "../../lib/cloud-workspace-host";
import { withCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { ensureCloudDockerWorkspace } from "../../lib/cloud-docker-workspace";
import { cloudDockerNeedsBuild } from "../../lib/resources";
import { strictRefreshImages } from "./pinned-artifacts";
import type { DeploymentConfigSnapshot } from "./build.service";

const isPermanentQueueError = (error: unknown): error is AppError =>
  error instanceof AppError &&
  error.statusCode >= 400 &&
  error.statusCode < 500 &&
  ![408, 425, 429].includes(error.statusCode) &&
  ![
    "CLOUD_WORKSPACE_ACTIVITY_BUSY",
    "CLOUD_WORKSPACE_BUSY",
    "CLOUD_BUILD_ACTIVITY_CHANGED",
    "CLOUD_WORKSPACE_NOT_RUNNING",
    "CLOUD_WORKSPACE_NOT_READY",
  ].includes(error.code ?? "");

/** Admission is short and shared across replicas. The existing host operation
 * lock still protects provisioning, command recovery and server lifecycle. */
export async function admitCloudBuild(
  project: Project,
  dep: Deployment,
  start: (
    resources?: ResourceConfig | null,
    backupPolicies?: readonly PreDeployBackupPolicy[],
  ) => Promise<string | null>,
): Promise<string | null> {
  if (!env.CLOUD_MODE || !project.workspaceId) return start();
  if (project.organizationId !== dep.organizationId || project.id !== dep.projectId)
    throw new AppError("Build ownership mismatch", 409, "BUILD_OWNERSHIP_MISMATCH");
  const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  if (!session) return null;
  await repos.deployment.requestCloudBuild(dep.id, dep.organizationId);
  return createProvisionLock(`cloud:build-admission:${project.workspaceId}`).run(async () => {
    const current = await repos.deployment.findById(dep.id);
    if (!current || current.status !== "queued") return session.id;
    const limit = await planBuildConcurrency(dep.organizationId, project.workspaceId!);
    const wait = async (reason: "concurrency" | "resources" | "server", message: string) => {
      await repos.deployment.setCloudBuildQueueWait(dep.id, dep.organizationId, {
        reason,
        limit,
        message,
      });
      return session.id;
    };
    const dispatch = async (
      resources: ResourceConfig | null,
      policies: readonly PreDeployBackupPolicy[],
    ) => {
      try {
        return await start(resources, policies);
      } catch (error) {
        // The atomic reservation can lose to maintenance after the host sample.
        // Its transaction leaves the deployment unclaimed, ready for a later sweep.
        if (
          error instanceof AppError &&
          ["CLOUD_WORKSPACE_ACTIVITY_BUSY", "CLOUD_WORKSPACE_BUSY"].includes(error.code ?? "")
        )
          return wait("server", "Waiting for the server operation to finish safely.");
        throw error;
      }
    };
    if (limit === 0)
      throw new PlanUpgradeRequiredError(
        "Choose a Cloud plan to build applications.",
        "build-minutes-exhausted",
        await currentPlanTier(dep.organizationId, project.workspaceId),
        project.workspaceId,
      );
    const snapshot = current.meta as DeploymentConfigSnapshot | null;
    if (!snapshot)
      throw new AppError(
        "Deployment configuration is missing. Create a new deployment.",
        400,
        "DEPLOYMENT_CONFIG_MISSING",
      );
    const { resolveServicePipelineMode } = await import("./build-pipeline");
    const mode = await resolveServicePipelineMode(project, snapshot);
    // A retained artifact can be missing; reserve for its source-build fallback.
    const needsBuild =
      !snapshot.releaseImageRef &&
      !snapshot.refreshAppDeploymentId &&
      (!mode.useServicePipeline ||
        cloudDockerNeedsBuild(mode.servicePreflightServices, strictRefreshImages(snapshot)));
    const reservations = await repos.cloudBuildActivity.listReservations(
      project.workspaceId!,
      dep.organizationId,
    );
    const active = await repos.cloudBuildActivity.listActive(
      project.workspaceId!,
      dep.organizationId,
    );
    // Pre-deploy dumps retain exclusive server admission. Keep their preparation
    // isolated rather than making a sibling build turn a required backup into a
    // failed deployment. Include deployment phases whose build slot was released.
    const backupPolicies = await repos.backupPolicy.listEnabledPreDeployByProject(project.id);
    if (
      active.length > 0 &&
      (backupPolicies.length > 0 || active.some((row) => row.exclusivePreparation))
    )
      return wait(
        "server",
        "Waiting for exclusive pre-deployment backup preparation to finish safely.",
      );
    const legacyExecutions = await repos.deployment.countActiveCloudBuilds(
      project.workspaceId!,
      dep.organizationId,
    );
    // Old workers have no independently tracked command ownership/resources.
    // Wait for their existing exclusive lifecycle to settle before parallel work.
    if (legacyExecutions > 0)
      return wait("server", "Waiting for an earlier deployment to finish safely.");
    if (
      needsBuild &&
      limit !== null &&
      reservations.filter((row) => row.resources !== null).length >= limit
    )
      return wait("concurrency", "Waiting for a build slot on your current plan.");
    // Do not let a new request jump ahead of already waiting work.
    const [first] = await repos.deployment.listRequestedCloudBuilds(project.workspaceId!, 1);
    if (needsBuild && first && first.id !== dep.id)
      return wait("concurrency", "Waiting for earlier submitted builds.");

    const requested = resolveBuildResources(snapshot.buildResources);
    const sampleUsage = needsBuild && (requested.cpuCores > 0 || requested.memoryMb > 0);
    let sample: Awaited<ReturnType<typeof sampleCloudWorkspaceResources>>;
    try {
      try {
        sample = await sampleCloudWorkspaceResources(dep.organizationId, project.workspaceId!, sampleUsage);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !["CLOUD_WORKSPACE_NOT_READY", "CLOUD_WORKSPACE_NOT_RUNNING"].includes(error.code ?? "")
        )
          throw error;
        // Provision/resume only through the existing exclusive lifecycle fence.
        await withCloudWorkspaceActivity(
          project.workspaceId,
          () =>
            ensureCloudDockerWorkspace({
              projectId: project.id,
              organizationId: dep.organizationId,
            }),
          undefined,
          { scope: `project:${project.id}` },
        );
        sample = await sampleCloudWorkspaceResources(dep.organizationId, project.workspaceId!, sampleUsage);
      }
    } catch (error) {
      if (isPermanentQueueError(error)) throw error;
      return wait("server", "Waiting for the managed server to become available.");
    }
    if (!needsBuild) return dispatch(null, backupPolicies);
    const decision = decideCloudBuildResources({
      capacity: sample.capacity,
      usage: sample.usage,
      requested,
      reservations: reservations.flatMap((row) => (row.resources ? [row.resources] : [])),
      concurrencyLimit: limit,
    });
    if (decision.kind === "wait")
      return wait(
        "resources",
        "Waiting for available server resources. You can keep waiting, free resources, or upgrade.",
      );
    if (decision.kind === "impossible" && decision.reason === "invalid-request")
      throw new AppError(
        "Choose automatic build resources or specify at least 0.25 vCPU and 128 MB of memory.",
        400,
        "CLOUD_BUILD_RESOURCES_INVALID",
      );
    if (decision.kind === "impossible")
      throw new AppError(
        `The requested build resources cannot fit this server (${sample.capacity.cpuCores} vCPU, ${sample.capacity.memoryMb} MB RAM). Lower the build allocation or upgrade the server.`,
        409,
        "CLOUD_WORKSPACE_BUILD_CAPACITY",
      );
    return dispatch(decision.resources, backupPolicies);
  });
}

/** Only submitted jobs are resumed; configuring a draft must never deploy it.
 * A periodic sweep supplies restart recovery and retries failed dispatch reads. */
export async function drainCloudBuildQueue(workspaceId?: string) {
  if (!env.CLOUD_MODE) return { started: 0 };
  // Snapshot all pages before claiming: mutations would otherwise shift offsets.
  const waiting: Deployment[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await repos.deployment.listRequestedCloudBuilds(workspaceId, 200, offset);
    waiting.push(...page);
    if (page.length < 200) break;
  }
  const { kickoffBuild } = await import("./build-pipeline");
  let started = 0;
  for (const dep of waiting) {
    try {
      const project = await repos.project.findByIdInOrganization(dep.projectId, dep.organizationId);
      if (!project || !project.workspaceId) continue;
      await kickoffBuild(project, dep);
      const current = await repos.deployment.findById(dep.id);
      if (current?.status === "building") started++;
    } catch (error) {
      if (isPermanentQueueError(error)) {
        try {
          const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
          if (session)
            await repos.deployment.failUnclaimedCloudBuild({
              deploymentId: dep.id,
              buildSessionId: session.id,
              projectId: dep.projectId,
              organizationId: dep.organizationId,
              errorMessage: error.message,
              errorCode: error.code,
            });
        } catch (persistError) {
          diagnostics.error(
            "cloud-build-queue",
            `Could not record rejection for ${dep.id}; retrying next sweep`,
            persistError,
          );
        }
      }
      diagnostics.error("cloud-build-queue", `Could not dispatch ${dep.id}`, error);
    }
  }
  return { started };
}

/** A sweep never assumes that a replica restart stopped other workers. Each
 * candidate must acquire its exact execution lock before any recovery occurs. */
export async function recoverCloudBuildQueue() {
  if (!env.CLOUD_MODE) return { recovered: 0 };
  const candidates = [];
  for (let offset = 0; ; offset += 200) {
    const page = await repos.cloudBuildActivity.listUnfinished({ limit: 200, offset });
    candidates.push(...page);
    if (page.length < 200) break;
  }
  const { recoverManagedDeploymentExecution } = await import("./deployment-recovery");
  let recovered = 0;
  for (const activity of candidates) {
    try {
      const [dep, project] = await Promise.all([
        repos.deployment.findById(activity.deploymentId),
        repos.project.findByIdInOrganization(activity.projectId, activity.organizationId),
      ]);
      if (!dep || !project || project.workspaceId !== activity.workspaceId) continue;
      // Give a newly claimed worker time to acquire its execution lock. This
      // only postpones inspection; age never proves that a live worker stopped.
      if (
        !activity.ownerToken &&
        ["queued", "building"].includes(dep.status) &&
        activity.reservedAt.getTime() > Date.now() - 30_000
      )
        continue;
      if (await recoverManagedDeploymentExecution(dep, project, { recoverInterrupted: true }))
        recovered++;
    } catch (error) {
      diagnostics.error(
        "cloud-build-queue",
        `Recovery remains pending for ${activity.deploymentId}`,
        error,
      );
    }
  }
  return { recovered };
}
