/**
 * Container resource decoding and inheritance. Managed and connected servers
 * share `0 = no additional cap`; the host's allocation is the physical ceiling.
 * Server provisioning and live build headroom are resolved separately.
 */

import {
  cloudCpus,
  type ResourceConfig,
} from "@repo/adapters";
import {
  UNLIMITED_RESOURCES,
  UNKNOWN_CAPACITY,
  detectTier,
  validateAgainstCapacity,
  type HostCapacity,
  type ProjectResources,
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

/**
 * Encode ResourceConfig → display format (for API responses).
 *
 * Missing limits use the whole server. Its subscription/allocation is independent
 * of the limits chosen for an individual project.
 */
export function encodeResources(
  production?: ResourceConfig | null,
  build?: ResourceConfig | null,
  sleepMode = "auto_sleep",
  port = 3000,
  opts?: { capacity?: HostCapacity; automaticBuild?: boolean },
): ProjectResources {
  const prod = withDefaults(production, UNLIMITED_RESOURCES);
  return {
    build: withDefaults(build, UNLIMITED_RESOURCES),
    ...(opts?.automaticBuild ? { buildMode: build ? "custom" as const : "automatic" as const } : {}),
    production: prod,
    sleepMode,
    port,
    tier: detectTier(prod),
    ...(opts?.capacity && { capacity: opts.capacity }),
    requiresLimit: false,
  };
}

/**
 * Validate user resource input → ResourceConfig.
 *
 * `0` means no additional container cap. Non-zero values are bounded by the
 * target machine's capacity; an unknown capacity enforces no ceiling.
 */
export function decodeResources(
  input: {
    cpuCores?: number;
    memoryMb?: number;
    diskMb?: number;
  },
  opts?: { capacity?: HostCapacity },
): ResourceConfig {
  const capacity = opts?.capacity ?? UNKNOWN_CAPACITY;
  const fallback = UNLIMITED_RESOURCES;

  const cores = input.cpuCores ?? fallback.cpuCores;
  const mem = input.memoryMb ?? fallback.memoryMb;
  const disk = input.diskMb ?? fallback.diskMb;

  if (![cores, mem, disk].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("Resource values must be finite and non-negative (use 0 for no limit).");
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
  defaults = UNLIMITED_RESOURCES,
): ResourceConfig {
  if (!config) return { ...defaults };

  const raw = config as Record<string, unknown>;
  const cpuCores = extractCpuCores(raw) ?? defaults.cpuCores;
  const memoryMb = (typeof raw.memoryMb === "number" ? raw.memoryMb : undefined) ?? defaults.memoryMb;
  const diskMb = (typeof raw.diskMb === "number" ? raw.diskMb : undefined) ?? defaults.diskMb;

  return { cpuCores, memoryMb, diskMb };
}

/** Normalize saved limits without adding a target-specific fallback. */
export function resolveRuntimeResources(
  raw: ResourceConfig | Record<string, unknown> | null | undefined,
): ResourceConfig {
  return withDefaults(raw, UNLIMITED_RESOURCES);
}

/** Each omitted service dimension inherits the project; explicit zero stays uncapped. */
export function resolveInheritedResources(
  own: ResourceConfig | Record<string, unknown> | null | undefined,
  project: ResourceConfig | Record<string, unknown> | null | undefined,
): ResourceConfig {
  return withDefaults(own, resolveRuntimeResources(project));
}

/** Build defaults share the host. Managed builds receive measured headroom at admission. */
export const resolveBuildResources = resolveRuntimeResources;

/** Shared by installation previews, plan checks, and VM provisioning. */
export interface CloudServiceResourceInput {
  name?: string;
  enabled?: boolean;
  kind?: string;
  image?: string | null;
  build?: unknown;
  advanced?: {
    resources?: ResourceConfig | Record<string, unknown> | null;
    build?: unknown;
    imageTemplate?: unknown;
  } | null;
}

export function cloudDockerNeedsBuild(
  services: CloudServiceResourceInput[],
  retainedImages?: Readonly<Record<string, string>>,
): boolean {
  return services.some((service) => cloudServiceNeedsBuild(service, retainedImages));
}

export function cloudServiceNeedsBuild(
  service: CloudServiceResourceInput,
  retainedImages?: Readonly<Record<string, string>>,
): boolean {
  return service.enabled !== false &&
    !(service.name && retainedImages?.[service.name]?.trim()) &&
    Boolean(service.build || service.advanced?.build || (service.kind === "monorepo" && !service.image));
}

export function cloudDockerResources(input: {
  resources?: ResourceConfig | Record<string, unknown> | null;
  buildResources?: ResourceConfig | Record<string, unknown> | null;
  reserveBuild?: boolean;
  services: Array<{
    enabled?: boolean;
    resources?: ResourceConfig | Record<string, unknown> | null;
  }>;
}): ResourceConfig {
  const resources = input.services
    .filter((s) => s.enabled !== false)
    .map((s) => resolveInheritedResources(s.resources, input.resources));
  const build = input.reserveBuild
    ? resolveBuildResources(input.buildResources)
    : null;
  // Image pulls need no source-build reservation. Include bounded Docker/OS
  // overhead; a source build receives temporary resources released after deployment.
  // Oblien accepts fractional CPU, including on Docker hosts. Use the same
  // normalization used by the provider instead of rounding up to whole cores.
  return {
    cpuCores: cloudCpus(
      Math.max(
        build?.cpuCores ?? 0,
        resources.reduce((n, r) => n + r.cpuCores, 0),
      ),
    ),
    memoryMb: Math.max(
      1024,
      Math.ceil(
        (512 + (build?.memoryMb ?? 0) + resources.reduce((n, r) => n + r.memoryMb, 0)) / 256,
      ) * 256,
    ),
    diskMb: Math.max(8192, build?.diskMb ?? 0, ...resources.map((r) => r.diskMb)),
  };
}
