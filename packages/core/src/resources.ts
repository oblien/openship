/**
 * Resource tiers — the ONE table the cloud (Oblien) power picker and the
 * self-hosted project settings both read.
 *
 * Two rules make this correct on both sides of the product:
 *
 *   1. `0` means NO LIMIT. Cloud never uses it (a metered workspace must be
 *      sized), but self-hosted defaults to it: the operator owns the box, so a
 *      container's real ceiling is the machine itself. Every consumer must
 *      therefore test `> 0` before applying a cap — see `hasCpuLimit` /
 *      `hasMemoryLimit`. Historically self-hosted silently inherited the cloud
 *      free tier (0.5 vCPU · 512 MB) and OOM-killed memory-hungry images.
 *   2. The ceiling for a custom value is the TARGET MACHINE's capacity, not a
 *      hardcoded constant. A 64 GB box should be able to give a container
 *      64 GB; the old fixed 8192 MB / 4-core cap made that impossible.
 */

/** Cloud-metered tiers + the two self-hosted-only selections. */
export type ResourceTier = "unlimited" | "micro" | "low" | "medium" | "high" | "custom";

/** Tiers that map to a fixed spec (i.e. everything the caller can't type into). */
export type FixedResourceTier = Exclude<ResourceTier, "custom" | "unlimited">;

export interface ResourceValues {
  /** vCPU. 0 = no limit. */
  cpuCores: number;
  /** Memory in MB. 0 = no limit. */
  memoryMb: number;
  /** Writable disk in MB. Only cloud workspaces enforce this. */
  diskMb: number;
}

/** No cap on anything — the self-hosted default. */
export const UNLIMITED_RESOURCES: ResourceValues = { cpuCores: 0, memoryMb: 0, diskMb: 0 };

/** The Oblien workspace tiers. Keep in sync with the cloud provisioner. */
export const RESOURCE_TIER_SPECS: Record<FixedResourceTier, ResourceValues> = {
  micro: { cpuCores: 0.25, memoryMb: 256, diskMb: 4096 },
  low: { cpuCores: 0.5, memoryMb: 512, diskMb: 8192 },
  medium: { cpuCores: 1, memoryMb: 1024, diskMb: 16384 },
  high: { cpuCores: 2, memoryMb: 2048, diskMb: 32768 },
};

/** Ordered for pickers (cheapest → largest). `unlimited`/`custom` are appended
 *  by the UI because their placement differs per surface. */
export const RESOURCE_TIER_ORDER: FixedResourceTier[] = ["micro", "low", "medium", "high"];

/** Every selectable tier, self-hosted included. Request validators derive their
 *  accepted set from this so adding a tier can't leave one schema behind. */
export const ALL_RESOURCE_TIERS: readonly ResourceTier[] = [
  "unlimited",
  ...RESOURCE_TIER_ORDER,
  "custom",
];

/** The cloud-selectable subset — no `unlimited`, since a metered workspace must
 *  be provisioned at a concrete size. */
export const CLOUD_RESOURCE_TIER_IDS: readonly (FixedResourceTier | "custom")[] = [
  ...RESOURCE_TIER_ORDER,
  "custom",
];

/** Floors. A cap below these is a misconfiguration, not a small container:
 *  Docker itself rejects Memory < 6 MB, and a sub-0.01 vCPU quota starves the
 *  process. `0` (unlimited) bypasses both — it isn't a "small" value. */
export const MIN_CPU_CORES = 0.25;
export const MIN_MEMORY_MB = 128;

/** What a target machine actually has. Probed from the host, never assumed. */
export interface HostCapacity {
  /** Physical/allocatable vCPU. 0 = unknown (probe failed). */
  cpuCores: number;
  /** Total RAM in MB. 0 = unknown (probe failed). */
  memoryMb: number;
  /** Where the numbers came from, for UI disclosure and debugging. */
  source: "docker" | "local" | "unknown";
}

export const UNKNOWN_CAPACITY: HostCapacity = { cpuCores: 0, memoryMb: 0, source: "unknown" };

export function hasCpuLimit(r?: { cpuCores?: number } | null): boolean {
  return typeof r?.cpuCores === "number" && r.cpuCores > 0;
}

export function hasMemoryLimit(r?: { memoryMb?: number } | null): boolean {
  return typeof r?.memoryMb === "number" && r.memoryMb > 0;
}

/** True when nothing is capped — the value a self-hosted project gets by default. */
export function isUnlimited(r?: { cpuCores?: number; memoryMb?: number } | null): boolean {
  return !hasCpuLimit(r) && !hasMemoryLimit(r);
}

/**
 * Tier (+ typed values when `custom`) → concrete numbers.
 *
 * A `custom` selection with nothing usable falls through to unlimited rather
 * than to a tier: the caller asked to opt out of the presets, so silently
 * pinning them to 512 MB is how the original bug happened.
 */
export function resolveTierResources(
  tier: ResourceTier,
  custom?: Partial<ResourceValues> | null,
): ResourceValues {
  if (tier === "unlimited") return { ...UNLIMITED_RESOURCES };
  if (tier === "custom") {
    const cpuCores = custom?.cpuCores ?? 0;
    const memoryMb = custom?.memoryMb ?? 0;
    const diskMb = custom?.diskMb ?? 0;
    if (cpuCores <= 0 && memoryMb <= 0) return { ...UNLIMITED_RESOURCES };
    return { cpuCores: Math.max(0, cpuCores), memoryMb: Math.max(0, memoryMb), diskMb: Math.max(0, diskMb) };
  }
  return { ...RESOURCE_TIER_SPECS[tier] };
}

/** Best-effort reverse lookup so a picker can highlight the saved selection. */
export function detectTier(values: ResourceValues | null | undefined): ResourceTier {
  if (!values || isUnlimited(values)) return "unlimited";
  for (const tier of RESOURCE_TIER_ORDER) {
    const spec = RESOURCE_TIER_SPECS[tier];
    if (spec.cpuCores === values.cpuCores && spec.memoryMb === values.memoryMb) return tier;
  }
  return "custom";
}

/**
 * Validate a resource selection against what the target machine actually has.
 * Returns a human-readable reason, or null when acceptable.
 *
 * An unknown capacity (probe failed) does NOT reject — refusing to save because
 * we couldn't SSH into the box would be worse than accepting a value the
 * operator chose deliberately. Only a *known* capacity is enforced.
 */
export function validateAgainstCapacity(
  values: ResourceValues,
  capacity: HostCapacity,
): string | null {
  if (hasCpuLimit(values)) {
    if (values.cpuCores < MIN_CPU_CORES) {
      return `CPU must be at least ${MIN_CPU_CORES} cores (or 0 for no limit).`;
    }
    if (capacity.cpuCores > 0 && values.cpuCores > capacity.cpuCores) {
      return `CPU limit ${values.cpuCores} exceeds the machine's ${capacity.cpuCores} cores.`;
    }
  }
  if (hasMemoryLimit(values)) {
    if (values.memoryMb < MIN_MEMORY_MB) {
      return `Memory must be at least ${MIN_MEMORY_MB} MB (or 0 for no limit).`;
    }
    if (capacity.memoryMb > 0 && values.memoryMb > capacity.memoryMb) {
      return `Memory limit ${values.memoryMb} MB exceeds the machine's ${capacity.memoryMb} MB.`;
    }
  }
  return null;
}

/** "no limit" / "512 MB" / "3 GB" — shared by the API's log lines and the UI. */
export function formatMemoryMb(mb: number): string {
  if (!mb || mb <= 0) return "no limit";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

/** "no limit" / "0.5 vCPU". */
export function formatCpuCores(cores: number): string {
  if (!cores || cores <= 0) return "no limit";
  return `${cores} vCPU`;
}
