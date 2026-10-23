/** Opt-in autoscaling uses the same project lock as deployment, stop and deletion.
 * A durable intent plus Kubernetes receipt closes the remote-write/DB-write gap.
 * No new step is admitted until the preceding rollout is fully ready. */
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos, type Project } from "@repo/db";
import {
  AppError,
  clusterWorkloadNeedsOperator,
  generateId,
  hasCpuLimit,
  safeErrorMessage,
  type AutoscaleEvent,
  type ClusterWorkloadStatus,
} from "@repo/core";
import { env } from "../../../config/env";
import { findActiveDeployment } from "../../../lib/active-deployment";
import { withDeploymentRuntime, type DeploymentMeta } from "../../../lib/deployment-runtime";
import { withLiveProjectRuntimeMutation } from "../../../lib/project-runtime-lock";

type Policy = NonNullable<Awaited<ReturnType<typeof repos.autoscale.get>>>;
// A same-count conditional patch retires an obsolete request without scaling.
// Its receipt is deterministic so a lost response can be reconciled too.
const cancelledScaleId = (operationId: string) => `${operationId}:cancelled`;
const HYSTERESIS_PERCENT = 10;
const SCALE_DOWN_MIN_COOLDOWN_SECONDS = 300;
// metrics-server normally refreshes every 15 seconds. Older samples cannot
// describe current demand; clock skew and missing timestamps also fail closed.
const MAX_METRIC_AGE_MS = 90_000;
const HELD_CODES = new Set([
  "CLUSTER_WORKLOAD_CONFLICT",
  "CLUSTER_RUNTIME_CONFLICT",
  "CLUSTER_RESOURCE_CHANGED",
  "AUTOSCALE_POLICY_CONFLICT",
  "CLUSTER_METRICS_UNAVAILABLE",
  "DEPLOYMENT_IN_PROGRESS",
  "BUILD_IN_PROGRESS",
  "PROJECT_DELETION_PENDING",
  "ROLE_HANDOVER_RECOVERY_PENDING",
]);

export function autoscaleEligibilityReason(p: Project, meta: DeploymentMeta | null): string | null {
  if (env.CLOUD_MODE || p.workspaceId) return "Autoscaling is available on self-hosted OpenShip.";
  if (p.appTemplateId === "openship") return "The OpenShip control plane cannot be autoscaled.";
  if (!p.clusterId) return "This project does not run on a server cluster.";
  if (!meta?.clusterId || meta.clusterId !== p.clusterId)
    return "Deploy this project to its selected cluster first.";
  if (
    meta.serviceDeploymentMode === "services" ||
    meta.composeDeployment ||
    p.framework === "static"
  )
    return "Autoscaling requires a single application process on K3s.";
  if (!hasCpuLimit((p.resources as { production?: { cpuCores?: number } } | null)?.production))
    return "Set a CPU limit for this project first: per-instance load is measured against its limit.";
  if (clusterWorkloadNeedsOperator(p.framework) || clusterWorkloadNeedsOperator(p.appTemplateId))
    return "Databases are replicated through database management, not instance scaling.";
  return null;
}

export interface AutoscaleTickResult {
  projectId: string;
  applied?: AutoscaleEvent["action"];
  held?: string;
  failed?: string;
}
const hold = (projectId: string, held: string): AutoscaleTickResult => ({ projectId, held });
const ready = (status: ClusterWorkloadStatus) =>
  status.desired > 0 &&
  status.observedGeneration >= status.generation &&
  status.ready === status.desired &&
  status.available === status.desired &&
  status.updated === status.desired;

export async function runAutoscaleTick(): Promise<{
  evaluated: number;
  results: AutoscaleTickResult[];
}> {
  if (env.CLOUD_MODE || (await repos.instanceSettings.get())?.autoscalerDisabled)
    return { evaluated: 0, results: [] };
  const policies = await repos.autoscale.listDue();
  const results: AutoscaleTickResult[] = [];
  for (const candidate of policies) {
    try {
      const result = await withLiveProjectRuntimeMutation(candidate.projectId, async (project) => {
        // The list is only a work hint. Policy saves, stop and deletion use this
        // lock too; reread after admission and keep error bookkeeping inside it.
        const policy = await repos.autoscale.get(project.id);
        if (!policy) return hold(project.id, "policy was removed");
        if (policy.nextAttemptAt && policy.nextAttemptAt.getTime() > Date.now())
          return hold(project.id, "retrying after backoff");
        try {
          const result = await scaleOnePolicy(project, policy);
          if (
            policy.failureCount &&
            ["no change needed", "cooling down after the last change"].includes(result.held ?? "")
          )
            await repos.autoscale.recordSuccess(project.id);
          return result;
        } catch (error) {
          if (
            error instanceof AppError &&
            (HELD_CODES.has(error.code ?? "") || error.statusCode === 409)
          )
            return hold(project.id, safeErrorMessage(error));
          reportCaughtError(error, "platform/engine/modules/projects/autoscaler");
          const reason = safeErrorMessage(error);
          await repos.autoscale.recordFailure(project.id, policy.suspendAfterFailures);
          await repos.autoscale.insertEvent(project.id, {
            createdAt: new Date().toISOString(),
            action: "fail",
            fromReplicas: 0,
            toReplicas: null,
            observedCpuPercent: null,
            reason,
          });
          return { projectId: project.id, failed: reason };
        }
      });
      results.push(result ?? hold(candidate.projectId, "project was removed or is being deleted"));
    } catch (error) {
      // Failure to acquire the lock or write diagnostics must not stop other projects.
      reportCaughtError(error, "platform/engine/modules/projects/autoscaler");
      results.push({ projectId: candidate.projectId, failed: safeErrorMessage(error) });
    }
  }
  return { evaluated: policies.length, results };
}

export function decideReplicas(
  observed: number,
  utilization: number,
  policy: {
    targetCpuPercent: number;
    minReplicas: number;
    maxReplicas: number;
    stepSize: number;
  },
): { direction: "scale_up" | "scale_down"; desired: number } | null {
  if (!Number.isFinite(utilization) || utilization < 0 || observed < 1) return null;
  const band = (policy.targetCpuPercent * HYSTERESIS_PERCENT) / 100;
  const formula = Math.ceil((observed * utilization) / policy.targetCpuPercent);
  const outsideBounds = observed < policy.minReplicas || observed > policy.maxReplicas;
  if (!outsideBounds && Math.abs(utilization - policy.targetCpuPercent) <= band) return null;
  const target = Math.max(
    policy.minReplicas,
    Math.min(policy.maxReplicas, outsideBounds ? observed : formula),
  );
  // stepSize bounds the change, including convergence from outside new limits.
  const desired = Math.max(
    observed - policy.stepSize,
    Math.min(observed + policy.stepSize, target),
  );
  if (desired === observed) return null;
  return { direction: desired > observed ? "scale_up" : "scale_down", desired };
}

async function suspend(
  projectId: string,
  reason: string,
  observed: number,
): Promise<AutoscaleTickResult> {
  await repos.autoscale.suspend(projectId, reason);
  await repos.autoscale.discardScale(projectId);
  await repos.autoscale.insertEvent(projectId, {
    createdAt: new Date().toISOString(),
    action: "suspend",
    fromReplicas: observed,
    toReplicas: null,
    observedCpuPercent: null,
    reason,
  });
  return hold(projectId, reason);
}

async function scaleOnePolicy(project: Project, policy: Policy): Promise<AutoscaleTickResult> {
  const projectId = project.id;
  if (!policy.pendingScale && (!policy.enabled || policy.suspendedAt))
    return hold(projectId, "policy is disabled or suspended");
  if (
    policy.pendingScale &&
    (policy.pendingScale.projectUpdatedAt !== project.updatedAt.toISOString() ||
      policy.pendingScale.deploymentId !== project.activeDeploymentId ||
      policy.pendingScale.clusterId !== project.clusterId)
  )
    return suspend(
      projectId,
      "The project or release changed during scaling. Review its instances before resuming autoscaling.",
      policy.pendingScale.replicas,
    );
  if (project.disabledAt) return hold(projectId, "the project is stopped");
  if ((await repos.instanceSettings.get())?.autoscalerDisabled)
    return hold(projectId, "autoscaling is disabled for this instance");
  const { checkNoActiveBuild } = await import("../../deployments/build.service");
  await checkNoActiveBuild(projectId);
  const active = await findActiveDeployment(project);
  if (!active?.containerId || active.containerId === "compose")
    return hold(projectId, "no scalable active release");
  const meta = active.meta as DeploymentMeta | null;
  const eligibility = autoscaleEligibilityReason(project, meta);
  if (eligibility) return hold(projectId, eligibility);

  return withDeploymentRuntime(active, async (runtime) => {
    if (
      !runtime.status ||
      !runtime.supports("scaleInPlace") ||
      !runtime.scaleInPlace ||
      !runtime.supports("podMetrics") ||
      !runtime.podMetrics
    )
      return hold(projectId, "the active runtime does not support autoscaling");
    const status = await runtime.status(active.containerId!);
    if (!status.scaling) return hold(projectId, "the runtime cannot verify scale ownership");
    const pending = policy.pendingScale;
    if (pending) {
      if (
        pending.deploymentId !== active.id ||
        pending.clusterId !== project.clusterId ||
        pending.projectUpdatedAt !== project.updatedAt.toISOString() ||
        pending.uid !== status.scaling.uid ||
        project.clusterConfig?.replicas !== pending.replicas
      )
        return suspend(
          projectId,
          "The project or release changed during scaling. Review its instances before resuming autoscaling.",
          status.desired,
        );
      if (
        status.scaling.operationId === pending.operationId &&
        status.desired === pending.toReplicas &&
        status.generation === pending.generation + 1
      ) {
        // The API response or DB commit may have been lost. This is the exact
        // accepted operation, so finish bookkeeping without another remote write.
        await repos.autoscale.completeScale(projectId, pending.operationId);
        return { projectId, applied: pending.event.action };
      }
      if (
        status.scaling.operationId === cancelledScaleId(pending.operationId) &&
        status.desired === pending.replicas &&
        status.generation === pending.generation + 1
      ) {
        await repos.autoscale.discardScale(projectId);
        return hold(projectId, "the obsolete scale request was cancelled");
      }
      if (status.generation !== pending.generation || status.desired !== pending.replicas)
        return suspend(
          projectId,
          "Instances changed outside the pending scale operation. Review them before resuming autoscaling.",
          status.desired,
        );
      // No receipt means acceptance is still uncertain. Reuse the SAME fresh
      // admission below as a new decision; old metrics/policy never authorize a retry.
      if (!policy.enabled || policy.suspendedAt)
        return hold(projectId, "policy is disabled or suspended");
    }
    if (!ready(status)) return hold(projectId, "the current rollout is still in progress");
    if (
      meta?.clusterConfig?.replicas !== status.desired ||
      project.clusterConfig?.replicas !== status.desired
    )
      return suspend(
        projectId,
        "Instances changed outside the autoscaler. Review them before resuming autoscaling.",
        status.desired,
      );
    // Use the CPU limit actually deployed, not a possibly edited project form.
    const limit = status.scaling.cpuLimitMillicores;
    if (!limit || !Number.isFinite(limit))
      return hold(projectId, "the running release needs a CPU limit");
    const metrics = await runtime.podMetrics(active.containerId!);
    const samples = new Map(metrics.pods.map((pod) => [pod.name, pod]));
    const pods = status.pods.filter((pod) => pod.ready);
    if (
      pods.length !== status.desired ||
      status.pods.length !== status.desired ||
      samples.size !== status.desired ||
      samples.size !== metrics.pods.length
    )
      return hold(projectId, "waiting for usage from every ready instance");
    let total = 0;
    for (const pod of pods) {
      const sample = samples.get(pod.name);
      const age = Date.now() - Date.parse(sample?.timestamp ?? "");
      if (
        !sample ||
        sample.cpuMillicores === null ||
        !Number.isFinite(sample.cpuMillicores) ||
        sample.cpuMillicores < 0 ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > MAX_METRIC_AGE_MS
      )
        return hold(projectId, "fresh instance CPU usage is unavailable");
      total += sample.cpuMillicores;
    }
    const utilization = (total / status.desired / limit) * 100;
    const decision = decideReplicas(status.desired, utilization, policy);
    if (pending && decision?.desired !== pending.toReplicas) {
      if ((await repos.instanceSettings.get())?.autoscalerDisabled)
        return hold(projectId, "autoscaling is disabled for this instance");
      await checkNoActiveBuild(projectId);
      // Do not just forget the intent: its delayed PATCH might still arrive.
      // Keep the observed count and advance the operation/generation atomically.
      // Either this patch wins (fencing the old one), or the old one wins and
      // its receipt is reconciled on the next tick. The pending intent survives
      // any ambiguous failure until one of those outcomes can be observed.
      await runtime.scaleInPlace(active.containerId!, pending.replicas, {
        ...pending,
        operationId: cancelledScaleId(pending.operationId),
      });
      await repos.autoscale.discardScale(projectId);
      return hold(projectId, "the obsolete scale request was cancelled");
    }
    if (!decision) return hold(projectId, "no change needed");
    const cooldownSeconds =
      decision.direction === "scale_down"
        ? Math.max(policy.cooldownSeconds, SCALE_DOWN_MIN_COOLDOWN_SECONDS)
        : policy.cooldownSeconds;
    const lastScale = await repos.autoscale.lastScaleEvent(projectId);
    if (lastScale && Date.now() - lastScale.createdAt.getTime() < cooldownSeconds * 1000)
      return hold(projectId, "cooling down after the last change");
    // Recheck admission after network reads. Global disable does not cancel an
    // already-accepted Kubernetes request, but prevents admitting the next one.
    if ((await repos.instanceSettings.get())?.autoscalerDisabled)
      return hold(projectId, "autoscaling is disabled for this instance");
    await checkNoActiveBuild(projectId);
    const intent = pending ?? {
      operationId: generateId("asc"),
      uid: status.scaling.uid,
      generation: status.generation,
      replicas: status.desired,
      toReplicas: decision.desired,
      deploymentId: active.id,
      clusterId: project.clusterId!,
      projectUpdatedAt: project.updatedAt.toISOString(),
      cooldownSeconds,
      event: {
        createdAt: new Date().toISOString(),
        action: decision.direction,
        fromReplicas: status.desired,
        toReplicas: decision.desired,
        observedCpuPercent: utilization,
        reason: `${Math.round(utilization)}% of the CPU limit vs a ${policy.targetCpuPercent}% target`,
      },
    };
    if (!pending) await repos.autoscale.beginScale(projectId, policy.updatedAt, intent);
    await runtime.scaleInPlace(active.containerId!, decision.desired, intent);
    await repos.autoscale.completeScale(projectId, intent.operationId);
    return { projectId, applied: decision.direction };
  });
}
