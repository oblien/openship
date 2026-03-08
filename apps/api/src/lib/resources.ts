/**
 * Resource management utilities — ported from old resourceManager.js.
 *
 * Handles CPU/memory tier management:
 *   - Convert between user-friendly (cpu_cores + tier) and VM-native (cpuConfig) formats
 *   - Validate resource requests
 *   - Apply resource defaults
 */

import {
  RESOURCE_TIERS,
  DEFAULT_RESOURCE_CONFIG,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  type ResourceConfig,
  type CpuConfig,
} from "@repo/adapters";

// ─── Conversion helpers ──────────────────────────────────────────────────────

/** Convert CPU cores (float) → VM-native CpuConfig */
function coresToCpuConfig(cores: number): CpuConfig {
  const periodUs = 100_000;
  return { quotaUs: Math.floor(cores * periodUs), periodUs };
}

/** Convert CpuConfig → CPU cores (float) */
function cpuConfigToCores(config: CpuConfig | null | undefined, cpus?: number): number {
  if (!config?.quotaUs || !config?.periodUs) return cpus ?? 1.0;
  return config.quotaUs / config.periodUs;
}

/** Detect tier name from cores + memory */
function detectTier(cpuCores: number, memoryMb: number): string {
  for (const [tier, config] of Object.entries(RESOURCE_TIERS)) {
    if (config.cpuCores === cpuCores && config.memoryMb === memoryMb) return tier;
  }
  return "custom";
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface UserFriendlyResources {
  cpuCores: number;
  memoryMb: number;
  tier: string;
}

export interface DeploymentResources {
  build: UserFriendlyResources;
  production: UserFriendlyResources;
  sleepMode: string;
  port: number;
}

/**
 * Encode VM-native ResourceConfig → user-friendly format (for API display).
 */
export function encodeResources(
  production?: ResourceConfig | null,
  build?: ResourceConfig | null,
  sleepMode = "auto_sleep",
  port = 3000,
): DeploymentResources {
  const encode = (config: ResourceConfig | null | undefined, defaults: ResourceConfig): UserFriendlyResources => {
    if (!config) {
      const cores = cpuConfigToCores(defaults.cpuConfig, defaults.cpus);
      return { cpuCores: cores, memoryMb: defaults.memoryMb, tier: detectTier(cores, defaults.memoryMb) };
    }
    const cores = cpuConfigToCores(config.cpuConfig, config.cpus);
    return { cpuCores: cores, memoryMb: config.memoryMb, tier: detectTier(cores, config.memoryMb) };
  };

  return {
    build: encode(build, DEFAULT_BUILD_RESOURCE_CONFIG),
    production: encode(production, DEFAULT_RESOURCE_CONFIG),
    sleepMode,
    port,
  };
}

/**
 * Validate and decode user resource input → VM-native ResourceConfig.
 * Accepts tier presets or custom cpu_cores/memory_mb values.
 */
export function decodeResources(input: {
  tier?: string;
  cpuCores?: number;
  memoryMb?: number;
}): ResourceConfig {
  const { tier, cpuCores, memoryMb } = input;

  // Tier preset
  if (tier && tier !== "custom" && RESOURCE_TIERS[tier]) {
    const preset = RESOURCE_TIERS[tier];
    return {
      cpus: Math.max(1, Math.ceil(preset.cpuCores)),
      cpuConfig: coresToCpuConfig(preset.cpuCores),
      memoryMb: preset.memoryMb,
    };
  }

  // Custom values
  const cores = cpuCores ?? 0.5;
  const mem = memoryMb ?? 512;

  if (cores < 0.25 || cores > 4.0) {
    throw new Error("CPU cores must be between 0.25 and 4.00");
  }
  if (mem < 128 || mem > 8192) {
    throw new Error("Memory must be between 128 MB and 8192 MB");
  }

  return {
    cpus: Math.max(1, Math.ceil(cores)),
    cpuConfig: coresToCpuConfig(cores),
    memoryMb: mem,
  };
}

/**
 * Ensure a ResourceConfig has all fields populated with safe defaults.
 */
export function withDefaults(
  config?: ResourceConfig | null,
  defaults = DEFAULT_RESOURCE_CONFIG,
): ResourceConfig {
  if (!config) return { ...defaults };
  return {
    cpus: config.cpus ?? defaults.cpus,
    cpuConfig: config.cpuConfig ?? defaults.cpuConfig,
    memoryMb: config.memoryMb ?? defaults.memoryMb,
  };
}
