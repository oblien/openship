import { ApiError } from "@/lib/api/client";
import type { BillingState } from "@/lib/api/billing";
import type { CloudAllocation } from "@repo/core";

/** Restore the same recovery from a persisted worker failure as from a request
 * refusal. App installs and the deployment page share this allowlist. */
export function cloudDeployFailure(failure: {
  errorCode?: string | null;
  errorDetails?: Record<string, unknown> | null;
  errorMessage?: string | null;
  projectId?: string | null;
}): ApiError | null {
  const code = failure.errorCode;
  if (code !== "CLOUD_CAPACITY_REQUIRED" && code !== "CLOUD_WORKSPACE_BUILD_CAPACITY" && code !== "CLOUD_BILLING_BLOCKED" && code !== "PLAN_UPGRADE_REQUIRED") return null;
  const projectId = failure.projectId ?? failure.errorDetails?.projectId;
  const capacity = code === "CLOUD_CAPACITY_REQUIRED" || code === "CLOUD_WORKSPACE_BUILD_CAPACITY";
  if (capacity && (typeof projectId !== "string" || !projectId)) return null;
  return new ApiError(capacity ? 409 : 402, "Cloud deployment needs attention", {
    ...failure.errorDetails,
    code,
    projectId,
    ...(failure.errorMessage ? { error: failure.errorMessage } : {}),
  });
}

/** Capacity refusals share a persistent action, separate from payment recovery. */
export function cloudDeployCapacityFailure(failure: Parameters<typeof cloudDeployFailure>[0]): ApiError | null {
  const error = cloudDeployFailure(failure);
  return error && (failure.errorCode === "CLOUD_WORKSPACE_BUILD_CAPACITY" || cloudCapacityRestriction(error))
    ? error : null;
}

export interface CloudCapacityRestriction {
  code: "CLOUD_CAPACITY_REQUIRED";
  projectId: string;
  requested?: CloudAllocation;
  reusesWorkspace?: boolean;
  scope?: "pool" | "workspace";
  message?: string;
  /** Null explicitly means an image-only deployment with no source builder. */
  buildResources?: CloudAllocation | null;
  buildMode?: "automatic" | "custom";
  additionalWorkspaces?: number;
}

function allocation(value: unknown): CloudAllocation | undefined {
  if (!value || typeof value !== "object") return;
  const { cpuCores, memoryMb, diskMb } = value as CloudAllocation;
  if ([cpuCores, memoryMb, diskMb].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0))
    return { cpuCores, memoryMb, diskMb };
}

/** Same public details for synchronous admission and persisted worker errors. */
export function cloudCapacityRestriction(error: unknown): CloudCapacityRestriction | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: unknown; error?: unknown; projectId?: unknown; capacity?: { requested?: unknown; existing?: unknown; buildResources?: unknown; buildMode?: unknown; additionalWorkspaces?: unknown; scope?: unknown } } | null;
  if (typeof body?.projectId !== "string" || !body.projectId) return null;
  const candidate = allocation(body.capacity?.buildResources);
  const buildResources = candidate && candidate.cpuCores > 0 && candidate.memoryMb > 0
    ? candidate : body.capacity?.buildResources === null ? null : undefined;
  const poolRefusal = error.status === 409 && body.code === "CLOUD_CAPACITY_REQUIRED";
  const buildRefusal = error.status === 402 && body.code === "PLAN_UPGRADE_REQUIRED" && !!buildResources;
  if (!poolRefusal && !buildRefusal) return null;
  const requested = allocation(body.capacity?.requested);
  // Only a verified reusable workspace gets delta accounting. Native Cloud
  // replacements need room for their full allocation while the old one runs.
  const existing = allocation(body.capacity?.existing);
  const reusesWorkspace = !!existing && [existing.cpuCores, existing.memoryMb, existing.diskMb]
    .every(n => typeof n === "number" && Number.isFinite(n) && n > 0);
  return {
    code: "CLOUD_CAPACITY_REQUIRED", projectId: body.projectId, requested, reusesWorkspace, buildResources,
    scope: buildRefusal || body.capacity?.scope === "workspace" ? "workspace" : "pool",
    ...(body.capacity?.buildMode === "automatic" || body.capacity?.buildMode === "custom"
      ? { buildMode: body.capacity.buildMode } : {}),
    ...(typeof body.capacity?.additionalWorkspaces === "number" && Number.isInteger(body.capacity.additionalWorkspaces) && body.capacity.additionalWorkspaces >= 0
      ? { additionalWorkspaces: body.capacity.additionalWorkspaces } : {}),
    ...(typeof body.error === "string" ? { message: body.error } : {}),
  };
}

export interface CloudDeployRestriction {
  code: "CLOUD_BILLING_BLOCKED" | "PLAN_UPGRADE_REQUIRED";
  reason?: string;
  message?: string;
}

/** Only an explicit deployment refusal can open pricing. Provider failures,
 * connectivity errors and ordinary permissions failures keep their own recovery. */
export function cloudDeployRestriction(error: unknown): CloudDeployRestriction | null {
  if (!(error instanceof ApiError) || error.status !== 402) return null;
  const body = error.body as { code?: unknown; reason?: unknown; error?: unknown } | null;
  if (body?.code !== "CLOUD_BILLING_BLOCKED" && body?.code !== "PLAN_UPGRADE_REQUIRED") return null;
  return {
    code: body.code,
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(typeof body.error === "string" ? { message: body.error } : {}),
  };
}

export type CloudDeployRecovery = "subscribe" | "upgrade" | "credits" | "payment" | "paused" | "ready";

/** A fresh billing snapshot selects the recovery, never authorizes a deployment.
 * The next Deploy still passes every server-side quota and resource check. */
export function cloudDeployRecovery(state: BillingState, restriction: CloudDeployRestriction): CloudDeployRecovery {
  const monthly = state.compute?.billingMode === "monthly";
  if (monthly && !state.compute!.covered) return "payment";
  if (state.status === "credit_exhausted" && (monthly || !state.overQuota)) return "paused";
  // A free account can also hit a Cloud subdomain limit while deploying to its
  // own server. Preserve that reason instead of implying local compute is paid.
  if (state.tier === "free") return restriction.code === "PLAN_UPGRADE_REQUIRED" && restriction.reason !== "project-limit" ? "upgrade" : "subscribe";
  if (!monthly && !["active", "trialing", "credit_exhausted"].includes(state.status)) return "payment";
  if (restriction.code === "PLAN_UPGRADE_REQUIRED") return "upgrade";
  if (!monthly && state.overQuota) return "credits";
  return "ready";
}
