/**
 * Openship Cloud (Oblien) resource tiers.
 *
 * The dashboard's `CLOUD_RESOURCE_TIERS` picker (DeployTargetStep.tsx) shows
 * matching labels; the numbers below are the concrete cpu/memory/disk they map
 * to. The resolved ResourceConfig rides `snapshot.resources` → `prodResources`
 * → the runtime's deploy config — see `requestBuildAccess`. Keep the two lists
 * in sync.
 *
 * Only consulted for a SERVER-BACKED cloud deploy. Static (Pages) deploys have
 * no workspace to size, and non-cloud targets keep the project's own resource
 * config.
 *
 * NOTE (current runtime coverage — plumbed, not yet fully enforced):
 *   - compose cloud: cpu/memory ARE applied (createImageServiceWorkspace);
 *     disk is currently hardcoded to the default (cloud/runtime/cloud/compose.ts).
 *   - single-app cloud: the deploy reuses the build workspace and the prod
 *     cpu/memory resize is intentionally disabled (cloud.ts `deploy()` TODO,
 *     "testing without resource shrink"), so the tier does NOT yet resize a
 *     single-app workspace. Re-enable that resize to make this fully effective.
 */

import type { ResourceConfig } from "@repo/adapters";
import { RESOURCE_TIER_SPECS, type FixedResourceTier, type ResourceTier } from "@repo/core";

export type CloudResourceTier = FixedResourceTier | "custom";

/** User-supplied values when tier === "custom". Same shape as ResourceConfig. */
export interface CloudResourceCustom {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
}

/** The tier table lives in @repo/core so the self-hosted project settings and
 *  this cloud provisioner can never drift apart. */
const TIER_RESOURCES: Record<FixedResourceTier, ResourceConfig> = RESOURCE_TIER_SPECS;

/**
 * Resolve a cloud resource tier (or custom values) into the concrete
 * ResourceConfig the cloud runtime provisions with. A "custom" selection
 * with missing/invalid values falls back to the "low" tier.
 *
 * Cloud has NO unlimited option (unlike self-hosted, where 0 = no cap): a
 * metered Oblien workspace must be provisioned at a concrete size, so a 0 here
 * is invalid input and lands on "low" like any other unusable custom value.
 */
export function resolveCloudResourceConfig(
  /** Accepts the FULL tier union, not just the cloud subset: this value can come
   *  from a repo's `openship.json`, so "unlimited" is reachable input even though
   *  it isn't a cloud option. Narrowing the parameter would only move the problem
   *  to a cast at the call site. */
  tier: ResourceTier,
  custom?: CloudResourceCustom | null,
): ResourceConfig {
  if (tier === "custom") {
    if (custom && custom.cpuCores > 0 && custom.memoryMb > 0 && custom.diskMb > 0) {
      return {
        cpuCores: custom.cpuCores,
        memoryMb: custom.memoryMb,
        diskMb: custom.diskMb,
      };
    }
    return TIER_RESOURCES.low;
  }
  // "unlimited" (or any tier with no cloud spec) → the free tier. A metered
  // workspace must be sized, and indexing the table with an unknown key would
  // return undefined-as-ResourceConfig, which crashes the cloud deploy later at
  // `config.resources.cpuCores`.
  return TIER_RESOURCES[tier as FixedResourceTier] ?? TIER_RESOURCES.low;
}
