import {
  AppError,
  type CloudAllocation,
} from "@repo/core";
import { OperationError } from "@repo/contracts";
import { getOblienClient } from "./oblien-client";
import { z } from "zod";

const workspaceResources = z.object({
  cpus: z.number().finite().positive(),
  memory_mb: z.number().int().positive(),
  disk_size_mb: z.number().int().positive(),
});

/** One ownership/shape check for both previews and deployment admission. */
export async function readCloudWorkspaceAllocation(workspaceId: string, namespace: string) {
  const workspace = await getOblienClient().workspaces.get(workspaceId);
  if (workspace.id !== workspaceId || workspace.namespace !== namespace) {
    throw new AppError("Cloud workspace ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  }
  const parsed = workspaceResources.safeParse(workspace.resources);
  if (!parsed.success)
    throw new AppError(
      "Cloud workspace allocation could not be verified",
      503,
      "CLOUD_CAPACITY_UNAVAILABLE",
    );
  const resources = parsed.data;
  return {
    workspace,
    allocation: {
      cpuCores: resources.cpus,
      memoryMb: resources.memory_mb,
      diskMb: resources.disk_size_mb,
    },
  };
}

/** Retain actionable capacity errors across an asynchronous deployment failure.
 * Only an allowlisted provider code enters this recovery; account/fleet failures
 * keep their support diagnosis rather than encouraging an unnecessary upgrade. */
export function cloudCapacityFailure(
  error: unknown,
  projectId: string,
  buildResources?: CloudAllocation | null,
  workspaceId?: string | null,
): OperationError | null {
  const seen = new Set<unknown>();
  // Adapter context must not hide an actionable provider refusal. Inspect only
  // typed causes, never parse arbitrary messages or provider response bodies.
  let current = error;
  while (current && typeof current === "object" && seen.size < 8 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof OperationError && (
      current.code === "CLOUD_CAPACITY_REQUIRED" ||
      (current.code === "PLAN_UPGRADE_REQUIRED" && current.details?.capacity)
    )) return current;
    if (current instanceof AppError && ["CLOUD_WORKSPACE_BUILD_CAPACITY", "CLOUD_WORKSPACE_USAGE_UNAVAILABLE", "CLOUD_BILLING_BLOCKED", "PLAN_UPGRADE_REQUIRED"].includes(current.code ?? "")) {
      const plan = current as AppError & { reason?: string; planTierId?: string };
      return new OperationError(current.message, current.statusCode, current.code, {
        projectId, ...(workspaceId ? { workspaceId } : {}),
        ...(plan.reason ? { reason: plan.reason } : {}), ...(plan.planTierId ? { planTierId: plan.planTierId } : {}),
      });
    }
    const value = current as { code?: unknown; requestId?: unknown; cause?: unknown };
    if (typeof value.code === "string" && value.code.toUpperCase() === "NAMESPACE_LIMIT_REACHED") {
      return new OperationError(
        "Cloud capacity changed before this deployment could start. Review the managed server and its plan, then retry.",
        409,
        "CLOUD_CAPACITY_REQUIRED",
        {
          projectId,
          ...(workspaceId ? { workspaceId } : {}),
          ...(buildResources !== undefined ? { capacity: { buildResources } } : {}),
          ...(typeof value.requestId === "string" && /^[a-f0-9-]{36}$/i.test(value.requestId)
            ? { reference: value.requestId }
            : {}),
        },
      );
    }
    current = value.cause;
  }
  return null;
}
