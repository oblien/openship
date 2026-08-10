/**
 * Resource config → Docker HostConfig limit fields.
 *
 * THE single place a cpu/memory cap becomes a Docker flag, so every
 * container-create path (single-app, compose service, app template) enforces
 * limits identically. Two rules:
 *
 *   - `0` / undefined = NO LIMIT, and the key is omitted entirely rather than
 *     sent as 0. Docker treats an absent Memory as unbounded; a self-hosted
 *     container should inherit the machine, not a cloud free tier.
 *   - CPU uses `NanoCpus`, not `CpuShares`. CpuShares is only a *relative
 *     weight* under contention — setting it to 512 for "0.5 cores" never
 *     capped anything, so a CPU limit was silently a no-op on an idle box.
 *     NanoCpus is the real quota (the `--cpus` flag).
 */

import { hasCpuLimit, hasMemoryLimit, formatCpuCores, formatMemoryMb } from "@repo/core";
import type { ResourceConfig } from "../types";

export interface DockerResourceLimits {
  Memory?: number;
  NanoCpus?: number;
}

export function dockerResourceLimits(
  resources?: Partial<ResourceConfig> | null,
): DockerResourceLimits {
  const limits: DockerResourceLimits = {};
  if (hasMemoryLimit(resources)) {
    limits.Memory = Math.round(resources!.memoryMb! * 1024 * 1024);
  }
  if (hasCpuLimit(resources)) {
    // Docker's floor is 1e6 (0.001 cores); anything below is rejected outright.
    limits.NanoCpus = Math.max(1_000_000, Math.round(resources!.cpuCores! * 1_000_000_000));
  }
  return limits;
}

/**
 * Build-time limits for the Docker BUILD API.
 *
 * Separate from {@link dockerResourceLimits} because `/build` takes different
 * fields than `/containers/create`: there is no `NanoCpus`, so a CPU cap has to
 * be expressed as a `CpuQuota`/`CpuPeriod` pair.
 *
 * Same `0 = no limit` rule, and the same omit-the-key behavior — which is why a
 * self-hosted build stays uncapped by default (a production build routinely
 * needs several GB, and it's the operator's own machine). Setting a build cap is
 * opt-in, and only useful on a small box where an unbounded `next build` would
 * otherwise take the whole host down.
 */
export interface DockerBuildResourceLimits {
  memory?: number;
  cpuperiod?: number;
  cpuquota?: number;
}

/** Docker's default CFS period; a quota is only meaningful relative to one. */
const CPU_PERIOD_US = 100_000;

export function dockerBuildResourceLimits(
  resources?: Partial<ResourceConfig> | null,
): DockerBuildResourceLimits {
  const limits: DockerBuildResourceLimits = {};
  if (hasMemoryLimit(resources)) {
    limits.memory = Math.round(resources!.memoryMb! * 1024 * 1024);
  }
  if (hasCpuLimit(resources)) {
    limits.cpuperiod = CPU_PERIOD_US;
    limits.cpuquota = Math.max(1_000, Math.round(resources!.cpuCores! * CPU_PERIOD_US));
  }
  return limits;
}

/**
 * Reverse of {@link dockerResourceLimits} — read the caps a LIVE container is
 * running with, so adopting/migrating one preserves them (including a limit set
 * by hand with `docker update --memory`, which used to be wiped on redeploy).
 *
 * `CpuQuota`/`CpuPeriod` is accepted alongside `NanoCpus` because that's what
 * `docker run --cpus` writes on older daemons and what compose's
 * `deploy.resources.limits.cpus` produces. Returns undefined when uncapped.
 */
export function inspectResourceLimits(
  hostConfig:
    | { Memory?: number; NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number }
    | undefined
    | null,
): { cpuCores?: number; memoryMb?: number } | undefined {
  if (!hostConfig) return undefined;
  const memoryMb =
    typeof hostConfig.Memory === "number" && hostConfig.Memory > 0
      ? Math.round(hostConfig.Memory / (1024 * 1024))
      : undefined;

  let cpuCores: number | undefined;
  if (typeof hostConfig.NanoCpus === "number" && hostConfig.NanoCpus > 0) {
    cpuCores = hostConfig.NanoCpus / 1_000_000_000;
  } else if (
    typeof hostConfig.CpuQuota === "number" &&
    hostConfig.CpuQuota > 0 &&
    typeof hostConfig.CpuPeriod === "number" &&
    hostConfig.CpuPeriod > 0
  ) {
    cpuCores = hostConfig.CpuQuota / hostConfig.CpuPeriod;
  }
  // Round to the 0.01 the UI and compose both speak, so 999999999ns doesn't
  // surface as 0.999999999 vCPU.
  if (cpuCores !== undefined) cpuCores = Math.round(cpuCores * 100) / 100;

  if (memoryMb === undefined && cpuCores === undefined) return undefined;
  return {
    ...(cpuCores !== undefined && { cpuCores }),
    ...(memoryMb !== undefined && { memoryMb }),
  };
}

/** One-line human summary for build logs ("2 vCPU · 4 GB", "no limits").
 *  Formatting comes from @repo/core so the build log, the API, and the dashboard
 *  all render a limit the same way. */
export function describeResourceLimits(resources?: Partial<ResourceConfig> | null): string {
  const parts = [
    hasCpuLimit(resources) ? formatCpuCores(resources!.cpuCores!) : null,
    hasMemoryLimit(resources) ? formatMemoryMb(resources!.memoryMb!) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no limits (machine capacity)";
}
