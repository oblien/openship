import { repos } from "@repo/db";
import {
  AppError,
  assertWorkloadReplicas,
  composeNamespaceDependencies,
  resolveProjectVolumes,
  safeErrorMessage,
  workloadReplicaUnsupportedReason,
} from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { WorkloadScalingSchemas, type WorkloadScaling } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import { withDeploymentRuntime, type DeploymentMeta } from "../../lib/deployment-runtime";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { findActiveDeployment } from "../../lib/active-deployment";
import { projectToClass } from "../deployments/deployment-class";
import { isMaterializedAppRow } from "../services/materialized-app-row";
import { isStaticService, resolveSubAppRecipe } from "../../lib/deployable-service";

export function createWorkloadScalingOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): ResourceServices<typeof WorkloadScalingSchemas> {
  async function load(ctx: ExecutionContext, id: string, serviceId?: string) {
    const project = await repos.project.findById(id);
    assertResourceInOrg(project, "Project", ctx.organizationId, id);
    const services = (await repos.service.listByProject(id)).filter((item) => item.enabled);
    const selected = serviceId ? services.find((item) => item.id === serviceId) : undefined;
    if (serviceId && !selected) throw new AppError("Service not found.", 404, "NOT_FOUND");
    const materializedApp = selected && isMaterializedAppRow(project, selected);
    const service = selected && !materializedApp ? selected : undefined;
    const active = await findActiveDeployment(project);
    const meta = active?.meta as
      (DeploymentMeta & { composeServices?: Array<{ name: string; replicas?: number }> }) | null;
    const configuration = service
      ? {
          workload: isStaticService(resolveSubAppRecipe(service, project)) ? "static" : undefined,
          image: service.image,
          framework: service.framework,
          volumes: service.volumes,
          advanced: service.advanced,
        }
      : {
          workload: projectToClass(project).workload,
          framework: project.framework,
          image: project.releaseSource?.imageTemplate,
          volumes: resolveProjectVolumes(project.volumes, project.framework),
          controlPlane: project.appTemplateId === "openship",
        };
    const rows = active && selected ? await repos.service.listByDeployment(active.id) : [];
    const row = rows.find((item) => item.serviceId === selected?.id);
    const namespaceDependent = services.find((item) =>
      composeNamespaceDependencies(item.advanced).includes(service?.name ?? project.slug),
    );
    const view: WorkloadScaling = {
      replicas: service ? (service.replicas ?? 1) : (project.replicas ?? 1),
      activeReplicas: service
        ? (meta?.composeServices?.find((item) => item.name === service.name)?.replicas ?? 1)
        : (meta?.replicas ?? 1),
      activeDeploymentId: active?.id ?? null,
      updatedAt: [
        project.updatedAt.toISOString(),
        ...(service ? [service.updatedAt.toISOString()] : []),
      ].join("/"),
      serviceId: service?.id ?? null,
      unavailableReason: project.clusterId
        ? "Use this cluster's instance settings."
        : !selected &&
            services.some((item) => !isMaterializedAppRow(project, item)) &&
            active?.containerId === "compose"
          ? "Select an application or service to change its instance count."
          : namespaceDependent
            ? `Service "${namespaceDependent.name}" shares this workload's network or process namespace. Remove that dependency before adding instances.`
            : workloadReplicaUnsupportedReason(configuration),
      status: null,
      error: null,
    };
    const containerId = service
      ? row?.containerId
      : materializedApp && active?.containerId === "compose"
        ? row?.containerId
        : active?.containerId;
    if (!view.unavailableReason && active && containerId && containerId !== "compose") {
      try {
        await withDeploymentRuntime(active, async (runtime) => {
          if (!runtime.supports("replicas") || !runtime.status) {
            view.unavailableReason = "Multiple instances require a single-server Docker runtime.";
            return;
          }
          if (
            (meta?.serverId ?? null) !== project.serverId ||
            (meta?.clusterId ?? null) !== project.clusterId
          ) {
            view.unavailableReason =
              "Deploy to the selected destination before changing instances.";
            return;
          }
          view.status = await runtime.status(containerId);
        });
      } catch (error) {
        reportCaughtError(error, "platform/engine/modules/projects/workload-scaling.operations");
        view.error = safeErrorMessage(error);
      }
    } else if (!view.unavailableReason && !containerId)
      view.unavailableReason = "Deploy this workload before changing its instance count.";
    return { project, service, active, configuration, view };
  }
  return {
    async getWorkloadScaling(ctx, id, input) {
      return (await load(ctx, id, input.serviceId)).view;
    },
    async scaleWorkload(ctx, id, input) {
      const result = await withLiveProjectRuntimeMutation(id, async (locked) => {
        assertResourceInOrg(locked, "Project", ctx.organizationId, id);
        const { project, service, active, configuration, view } = await load(
          ctx,
          id,
          input.serviceId,
        );
        if (
          view.updatedAt !== input.expectedUpdatedAt ||
          !active ||
          active.id !== input.expectedDeploymentId
        )
          throw new AppError(
            "The workload changed. Reload and review its instance count again.",
            409,
            "WORKLOAD_SCALING_CONFLICT",
          );
        if (view.unavailableReason || view.error)
          throw new AppError(
            view.unavailableReason ?? view.error!,
            409,
            "WORKLOAD_REPLICAS_UNAVAILABLE",
          );
        assertWorkloadReplicas(input.replicas, configuration);
        const { checkNoActiveBuild, triggerDeployment } =
          await import("../deployments/build.service");
        await checkNoActiveBuild(id);
        const saved = await repos.project.updateWorkloadReplicas(id, {
          replicas: input.replicas,
          serviceId: service?.id,
          expectedProjectUpdatedAt: project.updatedAt,
          expectedServiceUpdatedAt: service?.updatedAt,
          expectedActiveDeploymentId: project.activeDeploymentId,
        });
        if (!saved)
          throw new AppError(
            "The workload changed. Reload and review its instance count again.",
            409,
            "WORKLOAD_SCALING_CONFLICT",
          );
        recordAudit(ctx, {
          eventType: "project.updated",
          resourceType: "project",
          resourceId: id,
          after: {
            action: "workload.replicas",
            serviceId: service?.id ?? null,
            replicas: input.replicas,
          },
        });
        // Configuration releases reuse the image and the existing admission, history, cancellation and recovery path.
        const result = await triggerDeployment(ctx, {
          projectId: project.id,
          refresh: true,
          ...(service
            ? { serviceIds: [service.id], refreshServiceIds: [service.id] }
            : { forceAll: true }),
        });
        if (!result.deployment)
          throw new AppError("Deployment was not queued.", 409, "ACTIONS_CHECKS_PENDING");
        return { deploymentId: result.deployment.id };
      });
      if (!result) throw new AppError("Project is being removed.", 409, "PROJECT_UNAVAILABLE");
      return result;
    },
  };
}
