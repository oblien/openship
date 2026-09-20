import { AppError, planLimits, PRICING, RESOURCE_TIER_SPECS, type PlanTierId } from "@repo/core";
import type { Oblien } from "@repo/adapters";
import { getOblienClient } from "./oblien-client";

type NamespaceLimits = NonNullable<Parameters<Oblien["namespaces"]["update"]>[1]["resource_limits"]>;

/** A namespace must fit both native build VMs and a whole Compose stack. Its
 * containers still receive the customer's individual CPU/memory limits.
 * Oblien owns platform capacity. Never derive customer allowances from the
 * reseller's /workspace/quota response, including its unlimited values. */
export function cloudNamespaceLimits(tier: PlanTierId): NamespaceLimits {
  const plan = planLimits(tier);
  const build = PRICING.oblien.buildResources;
  const service = plan.maxResourceTier ? RESOURCE_TIER_SPECS[plan.maxResourceTier] : null;
  const count = plan.runningServices;
  return {
    max_workspaces: count === null ? null : count + PRICING.oblien.buildWorkspaceHeadroom,
    max_vcpus: service && count !== null ? Math.ceil(Math.max(build.cpuCores, 2, service.cpuCores * count)) : null,
    max_ram_mb: service && count !== null ? Math.max(build.memoryMb, 4096, build.memoryMb + service.memoryMb * count) : null,
    max_disk_gb: service ? Math.max(32, build.diskGb, Math.ceil(service.diskMb / 1024)) : null,
  };
}

export async function initialCloudNamespaceLimits(): Promise<NamespaceLimits> {
  return cloudNamespaceLimits("free");
}

/** Called under the billing lock, after reading the provider's current tier.
 * Only resource ceilings change here: credit grants, usage and suspension remain
 * provider-owned. A downgrade never deletes or shrinks an existing VM. */
export async function syncCloudResourceLimits(namespace: string, tier: PlanTierId): Promise<void> {
  const client = getOblienClient();
  const desired = cloudNamespaceLimits(tier);
  const { data: current } = await client.namespaces.get(namespace);
  if (current.slug !== namespace) throw new AppError("Cloud namespace ownership changed", 502, "CLOUD_NAMESPACE_MISMATCH");
  const matches = (limits: NamespaceLimits | null | undefined) =>
    (Object.keys(desired) as Array<keyof NamespaceLimits>).every(key => (limits?.[key] ?? null) === desired[key]);
  if (matches(current.resource_limits)) return;
  const { data: updated } = await client.namespaces.update(current.id, { resource_limits: desired });
  if (updated.slug !== namespace || !matches(updated.resource_limits)) {
    throw new AppError("Cloud resource limits were not confirmed", 502, "CLOUD_RESOURCE_LIMITS_UNCONFIRMED");
  }
}
