import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import {
  AppError,
  releaseArtifactKind,
  resolveProjectVolumes,
  safeErrorMessage,
  validateClusterWorkload,
  clusterWorkloadUnsupportedReason,
  type ClusterWorkloadStatus,
} from "@repo/core";
import { kubernetesProjectNamespace } from "@repo/adapters";
import { ProjectClusterSchemas, type ProjectCluster } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import {
  assertClusterWorkloadSupported,
  requireClusterDeploymentTarget,
} from "../../lib/cluster-deployment-target";
import { withDeploymentRuntime, type DeploymentMeta } from "../../lib/deployment-runtime";
import { findActiveDeployment } from "../../lib/active-deployment";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { assertProjectStorageEmpty } from "../../lib/project-storage-guard";
import { assertRouteProtectionTarget } from "../../lib/route-protection";
import { assertDomainProxyTarget } from "../../lib/domain-proxy-capabilities";
import { fleetAdmin } from "../system/managed-network.operations";
import {
  authorizeMember,
  assertClusterManagementAvailable,
} from "../system/server-cluster.operations";
import { projectToClass, snapshotToClass } from "../deployments/deployment-class";

export function createProjectClusterOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): ResourceServices<typeof ProjectClusterSchemas> {
  async function read(ctx: ExecutionContext, id: string): Promise<ProjectCluster> {
    assertClusterManagementAvailable();
    const project = await repos.project.findById(id);
    assertResourceInOrg(project, "Project", ctx.organizationId, id);
    const services = (await repos.service.listByProject(id)).filter((service) => service.enabled);
    const selectedRuntime = project.clusterId
      ? await repos.clusterRuntime.get(ctx.organizationId, project.clusterId)
      : null;
    const active = await findActiveDeployment(project);
    const meta = active?.meta as DeploymentMeta | null;
    const result: ProjectCluster = {
      unavailableReason:
        project.appTemplateId === "openship"
          ? "The OpenShip control plane cannot be replicated through application scaling."
          : clusterWorkloadUnsupportedReason({
              provider: selectedRuntime?.provider,
              workload: projectToClass(project).workload,
              framework: project.framework,
              image: project.releaseSource?.imageTemplate,
              volumes: resolveProjectVolumes(project.volumes, project.framework),
              services,
            }),
      clusterId: project.clusterId,
      serverId: project.serverId,
      config: project.clusterConfig,
      requiresImageRepository: services.length
        ? services.some((service) => !service.image || !!service.advanced?.build)
        : !project.releaseSource || releaseArtifactKind(project.releaseSource) !== "image",
      updatedAt: project.updatedAt.toISOString(),
      activeDeploymentId: active?.id ?? null,
      activeClusterId: meta?.clusterId ?? null,
      ...(meta?.clusterConfig ? { activeReplicas: meta.clusterConfig.replicas } : {}),
      internalHost:
        meta?.clusterId &&
        active?.containerId?.startsWith("k8s:") &&
        snapshotToClass(meta).workload === "web"
          ? `app.${kubernetesProjectNamespace(project.id)}.svc.cluster.local`
          : null,
      status: null,
      error: null,
      observedAt: null,
    };
    if (active?.containerId && meta?.clusterId) {
      try {
        result.status = await withDeploymentRuntime(active, async (runtime) => {
          if (!runtime.supports("clusterStatus") || !runtime.status)
            throw new Error("The active release does not use the cluster runtime.");
          if (active.containerId === "compose") {
            const rows = await repos.service.listByDeployment(active.id);
            const statuses: ClusterWorkloadStatus[] = [];
            for (const row of rows) {
              if (!row.containerId) continue;
              const status = await runtime.status(row.containerId);
              statuses.push({
                ...status,
                message: status.message ? `${row.serviceName}: ${status.message}` : null,
              });
            }
            if (!statuses.length)
              throw new Error("No service instances are recorded for this release.");
            return statuses.reduce((total, status) => ({
              desired: total.desired + status.desired,
              ready: total.ready + status.ready,
              available: total.available + status.available,
              updated: total.updated + status.updated,
              generation: total.generation + status.generation,
              observedGeneration: total.observedGeneration + status.observedGeneration,
              message: [total.message, status.message].filter(Boolean).join("; ") || null,
              pods: [...total.pods, ...status.pods],
            }));
          }
          return runtime.status(active.containerId!);
        });
        result.observedAt = new Date().toISOString();
      } catch (error) {
        observeCaughtError(error, "platform/engine/modules/projects/project-cluster.operations");
        result.error = safeErrorMessage(error);
      }
    }
    return result;
  }
  const record = (ctx: ExecutionContext, id: string, after: unknown) =>
    recordAudit(ctx, {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after,
    });
  return {
    getClusterWorkload: read,
    async setClusterTarget(ctx, id, input) {
      await fleetAdmin(ctx);
      const changed = await withLiveProjectRuntimeMutation(id, async (project) => {
        assertResourceInOrg(project, "Project", ctx.organizationId, id);
        if (input.clusterId) await assertDomainProxyTarget(project, "cluster");
        if (input.clusterId) await assertRouteProtectionTarget(project, "cluster");
        if (
          input.clusterId !== project.clusterId &&
          (await repos.clusterDatabase.list(ctx.organizationId, id)).some(
            (database) => database.clusterId !== input.clusterId,
          )
        )
          throw new AppError(
            "Choose the same cluster as this project's databases, or remove or migrate those databases before changing the application's cluster.",
            409,
            "CLUSTER_DATABASES_ATTACHED",
          );
        if (project.clusterId && input.clusterId !== project.clusterId)
          await assertProjectStorageEmpty(ctx.organizationId, id, project.clusterId);
        if (project.appTemplateId === "openship")
          throw new AppError(
            "The OpenShip control plane cannot be moved through workload scaling.",
            409,
            "CLUSTER_WORKLOAD_UNSUPPORTED",
          );
        const { checkNoActiveBuild } = await import("../deployments/build.service");
        await checkNoActiveBuild(id);
        if (input.clusterId) {
          if (!input.config)
            throw new AppError(
              "Choose how many application instances to run.",
              422,
              "CLUSTER_CONFIG_REQUIRED",
            );
          validateClusterWorkload(input.config);
          const { runtime } = await requireClusterDeploymentTarget(
            ctx.organizationId,
            input.clusterId,
          );
          if (
            runtime.provider === "swarm"
              ? input.acknowledgePlacement !== true
              : input.stateless !== true
          )
            throw new AppError(
              runtime.provider === "swarm"
                ? "Acknowledge Swarm placement: named volumes stay on the connected manager with one instance."
                : "Confirm that instances can run independently before selecting Kubernetes.",
              422,
              "CLUSTER_PLACEMENT_ACKNOWLEDGEMENT_REQUIRED",
            );
          if (
            runtime.provider === "swarm" &&
            project.clusterId !== input.clusterId &&
            // Failed/cancelled attempts can retain containers, images and data too.
            (await repos.deployment.findLatestByProject(project.id))
          )
            throw new AppError(
              "Create a new project on this Swarm. Moving a previously deployed project requires an explicit data and routing migration.",
              422,
              "CLUSTER_MIGRATION_REQUIRED",
            );
          for (const host of runtime.plan.hosts) await authorizeMember(ctx, host.serverId);
          await assertClusterWorkloadSupported({
            provider: runtime.provider,
            projectId: id,
            workload: projectToClass(project).workload,
            framework: project.framework,
            volumes: resolveProjectVolumes(project.volumes, project.framework),
            services: (await repos.service.listByProject(id)).filter((service) => service.enabled),
            image:
              project.releaseSource && releaseArtifactKind(project.releaseSource) === "image"
                ? (project.releaseSource.imageTemplate ?? "prebuilt")
                : undefined,
            imageRepository: input.config.imageRepository,
          });
        }
        await repos.clusterRuntime.bindProject(
          ctx.organizationId,
          id,
          input.clusterId,
          input.clusterId ? input.config! : null,
          input.expectedUpdatedAt,
        );
        record(ctx, id, {
          action: "cluster.target",
          clusterId: input.clusterId,
          config: input.config ?? null,
        });
        return true;
      });
      if (!changed) throw new AppError("Project is being removed.", 409, "PROJECT_UNAVAILABLE");
      return read(ctx, id);
    },
    async scaleClusterWorkload(ctx, id, input) {
      assertClusterManagementAvailable();
      const result = await withLiveProjectRuntimeMutation(id, async (project) => {
        assertResourceInOrg(project, "Project", ctx.organizationId, id);
        if (
          !project.clusterId ||
          !project.clusterConfig ||
          project.activeDeploymentId !== input.expectedDeploymentId ||
          project.updatedAt.toISOString() !== input.expectedUpdatedAt
        )
          throw new AppError(
            "The project or active release changed. Reload before scaling.",
            409,
            "CLUSTER_WORKLOAD_CONFLICT",
          );
        const active = await findActiveDeployment(project);
        const meta = active?.meta as DeploymentMeta | null;
        if (!meta?.clusterId || meta.clusterId !== project.clusterId)
          throw new AppError(
            "Deploy this project to its selected cluster before scaling it.",
            409,
            "CLUSTER_DEPLOY_REQUIRED",
          );
        const { checkNoActiveBuild, triggerDeployment } =
          await import("../deployments/build.service");
        await checkNoActiveBuild(id);
        const config = { ...project.clusterConfig, replicas: input.replicas };
        validateClusterWorkload(config);
        await assertDomainProxyTarget(project, "cluster");
        await repos.clusterRuntime.bindProject(
          ctx.organizationId,
          id,
          project.clusterId,
          config,
          input.expectedUpdatedAt,
        );
        record(ctx, id, { action: "cluster.replicas", replicas: input.replicas });
        // A configuration release reuses the immutable image. It uses the same
        // admission, cancellation, logs, history and recovery as every deploy.
        const deployed = await triggerDeployment(ctx, {
          projectId: id,
          refresh: true,
          forceAll: true,
        });
        if (!deployed.deployment)
          throw new AppError("Deployment was not queued", 409, "ACTIONS_CHECKS_PENDING");
        return { deploymentId: deployed.deployment.id };
      });
      if (!result) throw new AppError("Project is being removed.", 409, "PROJECT_UNAVAILABLE");
      return result;
    },
  };
}
