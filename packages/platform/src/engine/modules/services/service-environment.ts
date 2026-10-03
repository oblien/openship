import { CloudDockerRuntime, DockerRuntime } from "@repo/adapters";
import { AppError } from "@repo/core";
import { parseOptionalEnvironmentScope } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { findActiveDeployment } from "../../lib/active-deployment";
import { disposeRuntime, resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import {
  assertCloudRuntimeLimits,
  assertPlanAllowsServices,
  assertRunningServiceQuota,
} from "../../lib/plan-guard";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { assertNotControlPlane, assertResourceInOrg } from "../../lib/resource-access";
import { assertExactServiceTargets } from "../deployments/exact-service-targets";
import { reapplyProjectLiveRoutes } from "../domains/project-route.service";
import { applyProjectRouting } from "../domains/routing-apply.service";
import { liveContainerIdWithRuntime } from "./service-container";
import {
  loadServiceEnvironment,
  resolveServiceRuntimeEnvironment,
} from "./service-environment-state";

/** Apply current saved env to ONE existing service, like a restart. This path
 * never queues a deployment, invokes a builder, or creates a build session. */
export async function applyServiceEnvironment(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string,
) {
  return withProjectRuntimeLock(projectId, async () => {
    const project = await repos.project.findById(projectId);
    assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
    assertNotControlPlane(project);
    if (project.deletionInProgress)
      throw new AppError("This project is being deleted.", 409, "PROJECT_DELETING");
    const services = await repos.service.listByProject(projectId);
    const service = services.find((item) => item.id === serviceId);
    if (!service) throw new AppError("Service not found", 404, "NOT_FOUND");
    if (!service.enabled)
      throw new AppError(
        "Enable this service before applying its environment.",
        409,
        "SERVICE_DISABLED",
      );
    assertExactServiceTargets(services, [serviceId], "Apply environment");
    if ((await repos.deployment.listInFlightByProject(projectId)).length > 0) {
      throw new AppError(
        "A deployment is in progress. Apply the environment after it finishes.",
        409,
        "DEPLOYMENT_IN_PROGRESS",
      );
    }
    const deployment = await findActiveDeployment(project);
    if (!deployment)
      throw new AppError(
        "Deploy this service before applying its environment.",
        409,
        "SERVICE_NOT_DEPLOYED",
      );
    const row = (await repos.service.listByDeployment(deployment.id)).find(
      (item) => item.serviceId === serviceId,
    );
    if (!row?.containerId)
      throw new AppError(
        "This service has no deployed container. Use Redeploy first.",
        409,
        "SERVICE_NOT_DEPLOYED",
      );

    if (env.CLOUD_MODE) {
      await assertPlanAllowsServices(ctx.organizationId, project.workspaceId ?? null);
      await assertRunningServiceQuota(ctx.organizationId, 1, [serviceId], project.workspaceId ?? null);
    }
    const { runtime, serverId } = await resolveDeploymentRuntimeForRead({ ...deployment, meta: { ...(deployment.meta as Record<string, unknown>), runtimeMode: "docker" } });
    const cloudRuntime = runtime instanceof CloudDockerRuntime;
    try {
      if (!(runtime instanceof DockerRuntime)) {
        throw new AppError(
          "This service's runtime needs Redeploy to apply its environment.",
          409,
          "SERVICE_ENVIRONMENT_UNSUPPORTED",
        );
      }
      const containerId = await liveContainerIdWithRuntime(runtime, {
        service,
        projectId,
        slug: project.slug,
        tracked: row.containerId,
      });
      if (!containerId)
        throw new AppError(
          "The service container is missing. Use Redeploy.",
          409,
          "SERVICE_NOT_DEPLOYED",
        );
      if (env.CLOUD_MODE) {
        await assertCloudRuntimeLimits(ctx.organizationId, runtime, [
          { containerId, allocatedResources: row.allocatedResources },
        ], project.workspaceId ?? null);
      }

      // Capture BEFORE reading: a concurrent Save must remain pending if it
      // happens during this apply. Never stamp completion time as the cutoff.
      const appliedAt = new Date();
      const saved = await loadServiceEnvironment(
        ctx,
        projectId,
        serviceId,
        parseOptionalEnvironmentScope(deployment.environment),
      );
      const environment = await resolveServiceRuntimeEnvironment(ctx, saved, {
        serverId,
        cloudRuntime,
      });
      let routingChanged = false;
      const refreshRoutes = async (identity: { containerId: string; ip?: string }) => {
        const warnings: string[] = [];
        const routingOptions = {
          serviceRuntime: { serviceId, ...identity },
          onWarning: (message: string) => {
            warnings.push(message);
          },
        };
        // Reuse the complete route planners, including project domains and
        // composite paths. The target host and managed-edge destination did not
        // change, so an environment apply must not re-register cloud domains.
        await reapplyProjectLiveRoutes(project, [], {
          ...routingOptions,
          managedEdgeSyncedByCaller: true,
        });
        await applyProjectRouting(projectId, routingOptions);
        if (warnings.length) {
          throw new AppError(
            `Service routing could not be refreshed: ${[...new Set(warnings)].join("; ")}`,
            502,
            "SERVICE_ENVIRONMENT_ROUTING_FAILED",
          );
        }
      };
      const result = await runtime.applyEnvironment(containerId, environment, {
        projectId,
        serviceName: service.name,
        onReplaced: async (result) => {
          // Cloud Docker routes address stable workspace host ports. Its bridge
          // IP is private to that workspace and requires no cloud edge update.
          if (!cloudRuntime && result.ip && result.ip !== row.ip) {
            routingChanged = true;
            await refreshRoutes(result);
          }
          await repos.service.recordEnvironmentApply({
            projectId,
            organizationId: ctx.organizationId,
            deploymentId: deployment.id,
            serviceId,
            expectedContainerId: row.containerId,
            previousContainerId: containerId,
            containerId: result.containerId,
            ip: result.ip,
            appliedAt,
          });
        },
        onRestored: async (result) => {
          if (!cloudRuntime && (routingChanged || (result.ip && result.ip !== row.ip))) {
            await refreshRoutes(result);
          }
          // A rollback can also receive a new dynamic address. Refresh only the
          // live IP cache; the unapplied environment must remain pending.
          if (result.ip && result.ip !== row.ip) {
            await repos.service.updateServiceDeployment(row.id, { ip: result.ip });
          }
        },
      });
      return { success: true as const, ...result };
    } finally {
      disposeRuntime(runtime);
    }
  });
}
