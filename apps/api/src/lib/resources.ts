/**
 * Resource utilities.
 *
 * Tier table + `0 = no limit` semantics live in @repo/core (resources.ts);
 * the concrete cloud/build fallbacks live in @repo/adapters. This module is the
 * API-side glue: decode user input, and resolve what a given deploy target
 * should actually run with.
 *
 * THE rule that matters here: the 512 MB `DEFAULT_RESOURCE_CONFIG` is the CLOUD
 * free tier and must never be a self-hosted fallback. A self-hosted box is the
 * operator's own hardware, so its default is unlimited — the machine is the cap.
 * Use `resolveRuntimeResources`, not bare `withDefaults`, on any deploy path.
 */

import {
  DEFAULT_RESOURCE_CONFIG,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  type ResourceConfig,
} from "@repo/adapters";
import {
  UNLIMITED_RESOURCES,
  UNKNOWN_CAPACITY,
  detectTier,
  validateAgainstCapacity,
  type HostCapacity,
  type ResourceTier,
} from "@repo/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract cpuCores from a raw DB value, accepting either { cpuCores },
 * { cpuConfig: { quotaUs, periodUs } }, or { cpus }.
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
  /** Which preset the saved production values correspond to, so a picker can
   *  highlight the current selection without re-deriving it client-side. */
  tier: ResourceTier;
  /** What the target machine actually has — the ceiling for a custom value.
   *  Only present when a capacity was actually probed (the resources endpoint);
   *  ABSENT on the project list/info, which must not open an SSH connection per
   *  row just to fill a field nothing reads there. `source: "unknown"` means the
   *  probe ran and failed, so no ceiling is enforced — distinct from absent. */
  capacity?: HostCapacity;
  /** False on self-hosted, where "no limit" is a valid (and default) choice.
   *  True on cloud, where a metered workspace must be sized. */
  requiresLimit: boolean;
}

/**
 * Encode ResourceConfig → display format (for API responses).
 *
 * `production` null means "never configured". On self-hosted that resolves to
 * unlimited (the machine is the cap); on cloud it resolves to the free tier.
 */
export function encodeResources(
  production?: ResourceConfig | null,
  build?: ResourceConfig | null,
  sleepMode = "auto_sleep",
  port = 3000,
  opts?: { isCloud?: boolean; capacity?: HostCapacity },
): DeploymentResources {
  const isCloud = opts?.isCloud ?? false;
  const prod = production ?? (isCloud ? { ...DEFAULT_RESOURCE_CONFIG } : { ...UNLIMITED_RESOURCES });
  return {
    build: build ?? { ...(isCloud ? DEFAULT_BUILD_RESOURCE_CONFIG : UNLIMITED_RESOURCES) },
    production: prod,
    sleepMode,
    port,
    tier: detectTier(prod),
    ...(opts?.capacity && { capacity: opts.capacity }),
    requiresLimit: isCloud,
  };
}

/**
 * Validate user resource input → ResourceConfig.
 *
 * `0` is accepted and means NO LIMIT (self-hosted only — pass
 * `requireLimit: true` for cloud, where an unsized workspace can't be
 * provisioned). Non-zero values are bounded by the TARGET MACHINE's capacity
 * rather than a hardcoded ceiling; an unknown capacity enforces no ceiling.
 */
export function decodeResources(
  input: {
    cpuCores?: number;
    memoryMb?: number;
    diskMb?: number;
  },
  opts?: { capacity?: HostCapacity; requireLimit?: boolean },
): ResourceConfig {
  const capacity = opts?.capacity ?? UNKNOWN_CAPACITY;
  const fallback = opts?.requireLimit ? DEFAULT_RESOURCE_CONFIG : UNLIMITED_RESOURCES;

  const cores = input.cpuCores ?? fallback.cpuCores;
  const mem = input.memoryMb ?? fallback.memoryMb;
  const disk = input.diskMb ?? fallback.diskMb;

  if (cores < 0 || mem < 0 || disk < 0) {
    throw new Error("Resource values cannot be negative (use 0 for no limit).");
  }
  if (opts?.requireLimit && (cores <= 0 || mem <= 0)) {
    throw new Error("This deploy target requires explicit CPU and memory limits.");
  }

  const reason = validateAgainstCapacity({ cpuCores: cores, memoryMb: mem, diskMb: disk }, capacity);
  if (reason) throw new Error(reason);

  // Disk is only enforced by cloud workspaces, and its ceiling is the volume
  // the provider sells, not the control-plane host — keep the flat sanity bound.
  if (disk > 0 && (disk < 64 || disk > 204800)) {
    throw new Error("Disk must be between 64 MB and 204800 MB (or 0 for no limit).");
  }

  return { cpuCores: cores, memoryMb: mem, diskMb: disk };
}

/**
 * Ensure a ResourceConfig has all fields populated with safe defaults.
 * Accepts { cpus, cpuConfig } shapes transparently via extractCpuCores.
 *
 * An explicit `0` is preserved (it means "no limit", not "unset") — only a
 * missing/non-numeric field falls back to `defaults`.
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

/**
 * THE resolver every deploy path must use to turn a snapshot's raw resource
 * blob into what the runtime should enforce.
 *
 * Cloud gets the metered free tier when unset (an Oblien workspace must be
 * provisioned at a concrete size). Self-hosted gets NO limits when unset — the
 * operator owns the box, and inheriting the cloud tier there is what capped
 * every container at 512 MB and OOM-killed memory-hungry images.
 */
export function resolveRuntimeResources(
  raw: ResourceConfig | Record<string, unknown> | null | undefined,
  opts: { isCloud: boolean },
): ResourceConfig {
  if (!opts.isCloud) return withDefaults(raw, UNLIMITED_RESOURCES);
  // Cloud can't provision an unsized workspace, so a 0 ("no limit") has to
  // become a concrete tier here. The API rejects saving 0 against a cloud
  // target, but a project set to unlimited while self-hosted and LATER promoted
  // to cloud still carries one — it would otherwise reach Oblien as `memory_mb: 0`.
  const resolved = withDefaults(raw, DEFAULT_RESOURCE_CONFIG);
  return {
    cpuCores: resolved.cpuCores > 0 ? resolved.cpuCores : DEFAULT_RESOURCE_CONFIG.cpuCores,
    memoryMb: resolved.memoryMb > 0 ? resolved.memoryMb : DEFAULT_RESOURCE_CONFIG.memoryMb,
    diskMb: resolved.diskMb > 0 ? resolved.diskMb : DEFAULT_RESOURCE_CONFIG.diskMb,
  };
}

/** Same split for build-time resources. Only cloud sizes a build workspace;
 *  a self-hosted build container should use the whole machine. */
export function resolveBuildResources(
  raw: ResourceConfig | Record<string, unknown> | null | undefined,
  opts: { isCloud: boolean },
): ResourceConfig {
  if (!opts.isCloud) return withDefaults(raw, UNLIMITED_RESOURCES);
  const resolved = withDefaults(raw, DEFAULT_BUILD_RESOURCE_CONFIG);
  return {
    cpuCores: resolved.cpuCores > 0 ? resolved.cpuCores : DEFAULT_BUILD_RESOURCE_CONFIG.cpuCores,
    memoryMb: resolved.memoryMb > 0 ? resolved.memoryMb : DEFAULT_BUILD_RESOURCE_CONFIG.memoryMb,
    diskMb: resolved.diskMb > 0 ? resolved.diskMb : DEFAULT_BUILD_RESOURCE_CONFIG.diskMb,
  };
}
