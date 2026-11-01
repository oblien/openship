import { AppError, resolvePlan, type CloudCapacityPool, type PlanTierId } from "@repo/core";
import { getOblienClient } from "./oblien-client";
import { z } from "zod";

type NamespaceLimits = ReturnType<typeof cloudNamespaceLimits>;

/** Customer policy is explicit in the catalog. Oblien resolves current usage,
 * enforces aggregate allocation atomically and meters the credit balance. */
export function cloudNamespaceLimits(tier: PlanTierId) {
  return { ...resolvePlan(tier).oblienLimits };
}

export async function initialCloudNamespaceLimits(): Promise<NamespaceLimits> {
  return cloudNamespaceLimits("free");
}

/** Submit the verified subscription's declared policy under the billing lock.
 * The provider also enforces the saved paid contract before any client sync.
 * This updates no credits, usage or balance. Retail plans declare finite VM
 * and total caps; stricter saved caps are sent unchanged, including on renewal. */
export async function syncCloudResourceLimits(
  namespace: string,
  tier: PlanTierId,
  desired: NamespaceLimits = cloudNamespaceLimits(tier),
): Promise<void> {
  const client = getOblienClient();
  const { data: current } = await client.namespaces.get(namespace);
  if (current.slug !== namespace) throw new AppError("Cloud namespace ownership changed", 502, "CLOUD_NAMESPACE_MISMATCH");
  // Compare declared policy, never Oblien's effective_resource_limits: account
  // capacity may change without changing the customer's purchase contract.
  const matches = (limits: Partial<NamespaceLimits> | null | undefined) =>
    (Object.keys(desired) as Array<keyof NamespaceLimits>).every(key => (limits?.[key] ?? null) === desired[key]);
  if (matches(current.resource_limits)) return;
  const { data: updated } = await client.namespaces.update(current.id, { resource_limits: { ...desired } });
  if (updated.slug !== namespace || !matches(updated.resource_limits)) {
    throw new AppError("Cloud resource limits were not confirmed", 502, "CLOUD_RESOURCE_LIMITS_UNCONFIRMED");
  }
}

const capacityResponse = z.object({ success: z.literal(true), data: z.object({
  slug: z.string(),
  effective_resource_limits: z.object({ max_workspaces: z.number().nonnegative().nullable(),
    max_vcpus: z.number().nonnegative().nullable().optional(),
    max_ram_mb: z.number().nonnegative().nullable().optional(),
    max_disk_gb: z.number().nonnegative().nullable().optional(),
    max_total_vcpus: z.number().nonnegative().nullable(), max_total_ram_mb: z.number().nonnegative().nullable(),
    max_total_disk_gb: z.number().nonnegative().nullable() }).optional(),
  allocated_resource_usage: z.object({ workspaces: z.number().nonnegative(), vcpus: z.number().nonnegative(),
    ram_mb: z.number().nonnegative(), disk_gb: z.number().nonnegative(), pending_updates: z.number().int().nonnegative() }).optional(),
}) });

/** Read actual reserved capacity from Oblien. Openship never reconstructs this
 * from service counts, cached VM rows or the customer's credit balance. */
async function readNamespaceCapacity(namespace: string) {
  const parsed = capacityResponse.safeParse(await getOblienClient().namespaces.get(namespace));
  if (!parsed.success) throw new AppError("Cloud capacity could not be verified. Please retry.", 503, "CLOUD_CAPACITY_UNAVAILABLE");
  const { data } = parsed.data;
  if (data.slug !== namespace) throw new AppError("Cloud namespace ownership changed", 502, "CLOUD_NAMESPACE_MISMATCH");
  return data;
}

function presentCapacity(data: Awaited<ReturnType<typeof readNamespaceCapacity>>) {
  const limits = data.effective_resource_limits, used = data.allocated_resource_usage;
  if (!limits || !used) return {};
  return {
    workspaces: { used: used.workspaces, max: limits.max_workspaces },
    vcpus: { used: used.vcpus, max: limits.max_total_vcpus },
    ramMb: { used: used.ram_mb, max: limits.max_total_ram_mb },
    diskGb: { used: used.disk_gb, max: limits.max_total_disk_gb },
  };
}

export async function readCloudCapacity(namespace: string) {
  return presentCapacity(await readNamespaceCapacity(namespace));
}

/** Admission requires a complete, authoritative snapshot. Missing measurements
 * must not be interpreted as an empty pool or reconstructed from service rows. */
export async function readCloudCapacityPool(namespace: string): Promise<CloudCapacityPool> {
  return capacityPool(await readCloudCapacity(namespace));
}

function capacityPool(capacity: ReturnType<typeof presentCapacity>): CloudCapacityPool {
  if (!capacity.vcpus || !capacity.ramMb || !capacity.diskGb || !capacity.workspaces) {
    throw new AppError("Cloud capacity could not be verified. Retry when the provider is available.",
      503, "CLOUD_CAPACITY_UNAVAILABLE");
  }
  return {
    cpuCores: capacity.vcpus,
    memoryMb: capacity.ramMb,
    diskMb: { used: capacity.diskGb.used * 1024, max: capacity.diskGb.max === null ? null : capacity.diskGb.max * 1024 },
    workspaces: capacity.workspaces,
  };
}

/** Build sizing uses Oblien's current effective limits, including stricter
 * account/platform caps. The pricing catalog is not an allocation measurement. */
export async function readCloudBuildCapacity(namespace: string) {
  const data = await readNamespaceCapacity(namespace);
  const limits = data.effective_resource_limits;
  if (!limits || limits.max_vcpus === undefined || limits.max_ram_mb === undefined ||
      limits.max_disk_gb === undefined) {
    throw new AppError("Cloud build capacity could not be verified. Please retry.",
      503, "CLOUD_CAPACITY_UNAVAILABLE");
  }
  return {
    pool: capacityPool(presentCapacity(data)),
    workspace: {
      cpuCores: limits.max_vcpus,
      memoryMb: limits.max_ram_mb,
      diskMb: limits.max_disk_gb === null ? null : limits.max_disk_gb * 1024,
    },
  };
}
