/**
 * Resource utilities.
 *
 * Single source of truth: DEFAULT_RESOURCE_CONFIG / DEFAULT_BUILD_RESOURCE_CONFIG
 * in @repo/adapters. Everything flows from there.
 */

import {
  DEFAULT_RESOURCE_CONFIG,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  type ResourceConfig,
} from "@repo/adapters";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a possibly-legacy DB value into cpuCores.
 * Old format: { cpus, cpuConfig: { quotaUs, periodUs }, memoryMb }
 * New format: { cpuCores, memoryMb }
 */
function extractCpuCores(raw: Record<string, unknown>): number | undefined {
  if (typeof raw.cpuCores === "number") return raw.cpuCores;
  const cfg = raw.cpuConfig as { quotaUs?: number; periodUs?: number } | undefined;
  if (cfg?.quotaUs && cfg?.periodUs) return cfg.quotaUs / cfg.periodUs;
  if (typeof raw.cpus === "number") return raw.cpus;
  return undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface DeploymentResources {
  build: ResourceConfig;
  production: ResourceConfig;
  sleepMode: string;
  port: number;
}

/**
 * Encode ResourceConfig → display format (for API responses).
 */
export function encodeResources(
  production?: ResourceConfig | null,
  build?: ResourceConfig | null,
  sleepMode = "auto_sleep",
  port = 3000,
): DeploymentResources {
  return {
    build: build ?? { ...DEFAULT_BUILD_RESOURCE_CONFIG },
    production: production ?? { ...DEFAULT_RESOURCE_CONFIG },
    sleepMode,
    port,
  };
}

/**
 * Validate user resource input → ResourceConfig.
 */
export function decodeResources(input: {
  cpuCores?: number;
  memoryMb?: number;
  diskMb?: number;
}): ResourceConfig {
  const cores = input.cpuCores ?? DEFAULT_RESOURCE_CONFIG.cpuCores;
  const mem = input.memoryMb ?? DEFAULT_RESOURCE_CONFIG.memoryMb;
  const disk = input.diskMb ?? DEFAULT_RESOURCE_CONFIG.diskMb;

  if (cores < 0.25 || cores > 4.0) {
    throw new Error("CPU cores must be between 0.25 and 4.00");
  }
  if (mem < 128 || mem > 8192) {
    throw new Error("Memory must be between 128 MB and 8192 MB");
  }
  if (disk < 64 || disk > 204800) {
    throw new Error("Disk must be between 64 MB and 204800 MB");
  }

  return { cpuCores: cores, memoryMb: mem, diskMb: disk };
}

/**
 * Ensure a ResourceConfig has all fields populated with safe defaults.
 * Handles legacy DB format ({ cpus, cpuConfig }) transparently.
 */
export function withDefaults(
  config?: ResourceConfig | Record<string, unknown> | null,
  defaults = DEFAULT_RESOURCE_CONFIG,
): ResourceConfig {
  if (!config) return { ...defaults };

  const raw = config as Record<string, unknown>;
  const cpuCores = extractCpuCores(raw) ?? defaults.cpuCores;
  const memoryMb = (typeof raw.memoryMb === "number" ? raw.memoryMb : undefined) ?? defaults.memoryMb;
  const diskMb = (typeof raw.diskMb === "number" ? raw.diskMb : undefined) ?? defaults.diskMb;

  return { cpuCores, memoryMb, diskMb };
}
