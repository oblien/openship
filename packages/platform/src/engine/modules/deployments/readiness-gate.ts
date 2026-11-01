/**
 * Shared deployment verification policy for single apps and Compose services.
 * Managed Cloud containers always get a startup watch. TCP/HTTP probes remain
 * opt-in, with their own warning/failure policy. Other targets remain opt-in.
 */

import { SYSTEM } from "@repo/core";
import type { OpenshipReadiness, OpenshipReadinessFailureAction } from "@repo/core";

export interface ResolvedReadinessGate {
  /** TCP/HTTP readiness probe against the app's port. */
  probe: {
    enabled: boolean;
    /** Require an HTTP GET here to answer <500; undefined ⇒ bare TCP accept. */
    path?: string;
    /** Explicit override; undefined ⇒ probe whatever port the deploy published. */
    port?: number;
    timeoutMs: number;
    intervalMs: number;
  };
  /** Runtime-level watch for a restart loop (works on remote/SSH targets too). */
  stabilization: {
    enabled: boolean;
    windowMs: number;
    /** Startup failures are independent of custom probe failures. */
    onFailure: OpenshipReadinessFailureAction;
  };
  /** Failure policy for the optional TCP/HTTP probe. */
  onFailure: OpenshipReadinessFailureAction;
  /** True when at least one check is enabled — i.e. the pipeline needs a gate at all. */
  active: boolean;
}

/** Seconds → ms, ignoring anything non-finite or non-positive. */
function secondsToMs(seconds: number | undefined, fallbackMs: number): number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : fallbackMs;
}

/** Resolve optional probes and the target's minimum startup verification. */
export function resolveReadinessGate(
  config: OpenshipReadiness | null | undefined,
  options: { managedCloud?: boolean } = {},
): ResolvedReadinessGate {
  const probeEnabled = config?.enabled === true;
  const stabilizationEnabled = options.managedCloud === true || config?.stabilization === true;
  const onFailure = config?.onFailure === "fail" ? "fail" : "warn";
  const requestedWindow = secondsToMs(
    config?.stabilizationSeconds,
    SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS,
  );
  return {
    probe: {
      enabled: probeEnabled,
      path: config?.path?.trim() || undefined,
      port: typeof config?.port === "number" && config.port > 0 ? config.port : undefined,
      timeoutMs: secondsToMs(config?.timeoutSeconds, SYSTEM.DEPLOYMENTS.READINESS_TIMEOUT_MS),
      intervalMs: SYSTEM.DEPLOYMENTS.READINESS_INTERVAL_MS,
    },
    stabilization: {
      enabled: stabilizationEnabled,
      windowMs: options.managedCloud
        ? Math.max(SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS, requestedWindow)
        : requestedWindow,
      onFailure: options.managedCloud ? "fail" : onFailure,
    },
    // "warn" unless the project explicitly asked for a veto. Defaulting to "fail"
    // here would quietly restore the old behaviour for anyone who enabled a probe
    // just to get the log line.
    onFailure,
    active: probeEnabled || stabilizationEnabled,
  };
}

/**
 * Run an ACTIVE gate and apply its failure policy.
 *
 * The effects are injected so the ordering and the warn-vs-fail decision — the
 * parts that decide whether a deploy lives or dies — are testable without a
 * runtime, a container, or a socket.
 *
 * Each check uses its own failure policy. A veto is what
 * runDeployPipeline turns into a failed deploy plus a revert to the previous
 * deployment. Otherwise it reports through `onWarn` and returns normally, leaving
 * the deploy live.
 */
export async function runReadinessGate(opts: {
  gate: ResolvedReadinessGate;
  /** Watch the workload for a restart loop; failure detail or null. Omit when there's nothing to watch. */
  stabilize?: (windowMs: number) => Promise<string | null>;
  /** Dial the workload; failure detail or null. Omit when it isn't reachable from here. */
  probe?: () => Promise<string | null>;
  /** Why `probe` is missing even though it's enabled — logged so a skip is never silent. */
  probeSkippedReason?: string;
  onWarn: (detail: string) => void;
  log: (message: string, level?: "info" | "warn") => void;
}): Promise<void> {
  const { gate, stabilize, probe, probeSkippedReason, onWarn, log } = opts;
  if (!gate.active) return;

  const failures: string[] = [];

  if (gate.stabilization.enabled && stabilize) {
    const detail = await stabilize(gate.stabilization.windowMs);
    if (detail) {
      if (gate.stabilization.onFailure === "fail") throw new Error(detail);
      failures.push(detail);
    }
  }

  // Skip the probe once stabilization already failed: dialing a port on a workload
  // we know is bouncing just adds a full timeout to a verdict that's already in.
  if (gate.probe.enabled && failures.length === 0) {
    if (!probe) {
      if (probeSkippedReason) log(probeSkippedReason, "warn");
    } else {
      const detail = await probe();
      if (detail) failures.push(detail);
    }
  }

  if (failures.length === 0) return;
  const detail = failures.join("\n");
  if (gate.onFailure === "fail") throw new Error(detail);
  log(
    "Health check reported a problem, but this project's health check is set to warn — " +
      "the deploy stays live and is flagged for review.",
    "warn",
  );
  onWarn(detail);
}
