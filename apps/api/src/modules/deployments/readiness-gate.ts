/**
 * The deploy-time readiness gate, resolved from a project's `readiness`.
 *
 * OFF IS THE DEFAULT, and that is the whole point of this module. Both post-start
 * checks used to be hardcoded on every deploy — a 15s stabilization watch plus a
 * 45s TCP probe — and both could throw, which failed the deploy and then
 * force-removed the container that had just started successfully. Up to a minute
 * on the critical path to reach a verdict that could delete a working app.
 *
 * What replaced it: nothing, unless the project asks. A deploy with no
 * `readiness` runs neither check and reports ready as soon as the workload is up
 * and routed. "Is my app actually listening?" is still answered — by the ADVISORY
 * in-container probe the pipeline already runs after the deploy is live
 * (`auditPorts` → `meta.portCheck`, re-runnable via POST /projects/:id/port-check),
 * which by construction cannot fail a deploy.
 *
 * A project opts in when it wants the deploy itself to refuse to go green. Even
 * then `onFailure` defaults to "warn": the deploy stays ready and carries an
 * action-required warning. Only an explicit `onFailure: "fail"` vetoes a deploy,
 * and that path now reverts to the previous deployment instead of destroying it.
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
  };
  /** What a failed check does. */
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

/**
 * Resolve a project's stored `readiness` into the effective gate.
 *
 * Null/undefined/`{}` all resolve to inactive — `active: false` is what makes the
 * pipeline pass `readiness: undefined` to runDeployPipeline and skip the step
 * outright, rather than invoking a no-op check.
 */
export function resolveReadinessGate(
  config: OpenshipReadiness | null | undefined,
): ResolvedReadinessGate {
  const probeEnabled = config?.enabled === true;
  const stabilizationEnabled = config?.stabilization === true;
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
      windowMs: secondsToMs(
        config?.stabilizationSeconds,
        SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS,
      ),
    },
    // "warn" unless the project explicitly asked for a veto. Defaulting to "fail"
    // here would quietly restore the old behaviour for anyone who enabled a probe
    // just to get the log line.
    onFailure: config?.onFailure === "fail" ? "fail" : "warn",
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
 * Throws when a check failed and `onFailure` is "fail"; that throw is what
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
    if (detail) failures.push(detail);
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
