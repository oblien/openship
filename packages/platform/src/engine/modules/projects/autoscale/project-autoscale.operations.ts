/**
 * Autoscaling policy operations — the operator's view of the autoscaler.
 *
 * The policy gates mirror the tick's eligibility rules so a policy can only be
 * SAVED for a project where the loop can actually work; refusing early is
 * cheaper than saving a policy that silently holds forever.
 *
 * Suspension is one-way through these ops: the tick, a drift detector or a
 * human replica edit suspends ownership; only `setAutoscalePolicy` with
 * `rearm: true` resumes it.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { ProjectAutoscaleSchemas, type ProjectAutoscalePolicy } from "@repo/contracts";
import type { ResourceServices } from "../../../../resource-operations";
import type { ProjectDependencies } from "../../../../projects";
import type { ExecutionContext } from "../../../../context";
import { assertResourceInOrg } from "../../../lib/resource-access";
import { assertClusterManagementAvailable } from "../../system/server-cluster.operations";
import { autoscaleEligibilityReason } from "./autoscaler";
import { findActiveDeployment } from "../../../lib/active-deployment";
import type { DeploymentMeta } from "../../../lib/deployment-runtime";
import { withProjectStateLock } from "../../../lib/project-runtime-lock";

const present = (
  row: NonNullable<Awaited<ReturnType<typeof repos.autoscale.get>>>,
): ProjectAutoscalePolicy => ({
  projectId: row.projectId,
  enabled: row.enabled === 1,
  targetCpuPercent: row.targetCpuPercent,
  minReplicas: row.minReplicas,
  maxReplicas: row.maxReplicas,
  stepSize: row.stepSize,
  cooldownSeconds: row.cooldownSeconds,
  suspendAfterFailures: row.suspendAfterFailures,
  suspendedAt: row.suspendedAt?.toISOString() ?? null,
  suspendedReason: row.suspendedReason,
  lastDecision: row.lastDecision,
  updatedAt: row.updatedAt.toISOString(),
});

export function createAutoscaleOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): ResourceServices<typeof ProjectAutoscaleSchemas> {
  const record = (ctx: ExecutionContext, id: string, after: unknown) =>
    recordAudit(ctx, {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after,
    });

  return {
    async getAutoscalePolicy(ctx, id): Promise<ProjectAutoscalePolicy> {
      assertClusterManagementAvailable();
      const project = await repos.project.findById(id);
      assertResourceInOrg(project, "Project", ctx.organizationId, id);
      const row = await repos.autoscale.get(id);
      if (!row)
        // The dashboard renders defaults + the eligibility gates from this.
        throw new AppError(
          "This project has no autoscaling policy yet.",
          404,
          "AUTOSCALE_POLICY_ABSENT",
        );
      return present(row);
    },
    async setAutoscalePolicy(ctx, id, input): Promise<ProjectAutoscalePolicy> {
      assertClusterManagementAvailable();
      return withProjectStateLock(id, async () => {
        const project = await repos.project.findById(id);
        assertResourceInOrg(project, "Project", ctx.organizationId, id);
        if (project.appTemplateId === "openship")
          throw new AppError(
            "The OpenShip control plane cannot be autoscaled.",
            422,
            "CLUSTER_WORKLOAD_UNSUPPORTED",
          );
        // Domain rules before the write, so a bad policy is a clean 422 instead
        // of the table's raw check constraint.
        if (input.maxReplicas < input.minReplicas)
          throw new AppError(
            "Max instances must be at least min instances.",
            422,
            "CLUSTER_CONFIG_INVALID",
          );
        if (input.enabled) {
          const runtime = project.clusterId
            ? await repos.clusterRuntime.get(ctx.organizationId, project.clusterId)
            : null;
          if (runtime?.provider !== "k3s" || runtime.status !== "ready")
            throw new AppError(
              "Autoscaling requires a ready K3s cluster.",
              422,
              "AUTOSCALE_POLICY_INELIGIBLE",
            );
          const active = await findActiveDeployment(project);
          const meta = (active?.meta as DeploymentMeta | null) ?? null;
          const eligibility = autoscaleEligibilityReason(project, meta);
          if (eligibility) throw new AppError(eligibility, 422, "AUTOSCALE_POLICY_INELIGIBLE");
        }
        const row = await repos.autoscale.save(id, {
          enabled: input.enabled,
          targetCpuPercent: input.targetCpuPercent,
          minReplicas: input.minReplicas,
          maxReplicas: input.maxReplicas,
          stepSize: input.stepSize,
          cooldownSeconds: input.cooldownSeconds,
          suspendAfterFailures: input.suspendAfterFailures,
          ...(input.rearm ? { rearm: input.rearm } : {}),
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
        record(ctx, id, { action: "autoscale.policy", ...input });
        return present(row);
      });
    },
    async listAutoscaleEvents(ctx, id) {
      assertClusterManagementAvailable();
      const project = await repos.project.findById(id);
      assertResourceInOrg(project, "Project", ctx.organizationId, id);
      return {
        events: (await repos.autoscale.listEvents(id)).map((event) => ({
          id: event.id,
          createdAt: event.createdAt.toISOString(),
          action: event.action,
          fromReplicas: event.fromReplicas,
          toReplicas: event.toReplicas,
          observedCpuPercent: event.observedCpuPercent,
          reason: event.reason,
        })),
      };
    },
  };
}

/** Human override handshake: called by every operation that moves the replica
 * count or swaps the active release outside the autoscaler. Re-arm happens only
 * through the dashboard. Best-effort: a suspension write must never fail the
 * triggering operation. */
export async function suspendAutoscaleOnOverride(
  projectId: string,
  from: number | undefined,
  to: number | undefined,
): Promise<void> {
  try {
    const change =
      from !== undefined && to !== undefined
        ? `replicas changed to ${to} (from ${from})`
        : "the active release changed";
    const reason = `${change[0].toUpperCase()}${change.slice(1)} outside the autoscaler. It suspended this policy and is no longer changing the instance count.`;
    await withProjectStateLock(projectId, () => repos.autoscale.suspend(projectId, reason));
  } catch (error) {
    observeCaughtError(error, "platform/engine/modules/projects/autoscale.operations");
  }
}
