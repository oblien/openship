/**
 * Steady-state health verdict: is a workload that has been running for days
 * broken RIGHT NOW?
 *
 * Superficially this is what `classifyStability` already answers, but that
 * classifier is deploy-time and its assumptions do not transfer. It judges a
 * container we JUST created, so "exited, with `restart: always`, at the end of the
 * window" is conclusive evidence of a crash there — while in steady state that is
 * overwhelmingly a human running `docker stop` (docker does not restart a
 * container it was told to stop, whatever the policy says). Reusing it verbatim
 * would turn every deliberate stop into a page, which is exactly how an alerting
 * channel gets muted.
 *
 * So: a separate, narrower judgement over a single sample plus two pieces of
 * context the caller owns — the previous tick's restart count, and whether this
 * workload is even supposed to be running.
 *
 * Pure and synchronous. The caller owns polling, intent, confirmation counting and
 * notification; this only names what it sees.
 */

import { restartsAfter, type ContainerStabilitySample } from "@repo/adapters";
import type { IncidentKind } from "@repo/db";

/** Kinds this classifier can produce (never `server_unreachable` — that's the sweep's). */
export type WorkloadIncidentKind = Exclude<IncidentKind, "server_unreachable">;

export interface SteadyStateContext {
  /**
   * `RestartCount` when the baseline was anchored, or null when we have no
   * baseline (first tick after a control-plane restart). Docker's counter is
   * monotonic per container, so the DELTA since the baseline is what
   * distinguishes "restarted 40 times last week" from "restarting right now" —
   * an absolute count cannot.
   */
  prevRestartCount: number | null;
  /**
   * How long ago that baseline was anchored. Only used to phrase the reason —
   * whether a delta is judged at all is the caller's decision, since it owns the
   * baseline's lifetime. Undefined falls back to the wording this rule carried
   * when every observation was one cron tick apart.
   */
  baselineAgeMs?: number;
  /**
   * Whether this workload is supposed to be up: false when the operator stopped
   * the service or disabled the project. Without it, intent is unknowable — a
   * stopped container looks identical either way.
   */
  expectRunning: boolean;
  /** Consecutive prior ticks that already saw this container in `created`. */
  createdTicks?: number;
}

/**
 * WHY there is no fault — three different statements, and the caller must act
 * differently on each:
 *
 * - `healthy`: positively observed fine. The only one that may close an open
 *   incident with an "is back up".
 * - `unknown`: this sample proves nothing either way (a container that is not
 *   running and no exit code to explain it, a state string this docker version
 *   added, an inspect that raced a removal). Neither open nor close.
 * - `not_expected`: it is down and that is deliberate — the operator stopped the
 *   service, disabled it, or paused the container. An open incident is closed
 *   SILENTLY; announcing a recovery for a service somebody switched off is a lie.
 *
 * Collapsing these into one bare `null` is what made a container we could not
 * inspect, and a container an operator had just stopped, both send "is back up".
 */
export type SteadyStateClear = "healthy" | "unknown" | "not_expected";

export type SteadyStateVerdict =
  | {
      kind: WorkloadIncidentKind;
      /** One line, already phrased for an operator. */
      reason: string;
      clear?: undefined;
    }
  | { kind: null; reason: ""; clear: SteadyStateClear };

/** Restart delta within one tick that means "this is bouncing, not recovering". */
export const CRASH_RESTART_DELTA = 3;

const ok = (clear: SteadyStateClear): SteadyStateVerdict => ({ kind: null, reason: "", clear });

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Phrase the delta's window from the measured gap.
 *
 * This used to be the literal string "the last minute", which was true only
 * while the caller was a once-a-minute cron. Event-accelerated observations
 * arrive seconds apart and a resumed sweep can carry a much older baseline, so
 * an operator reading "3 restarts in the last minute" about a 9-second window
 * was being told the wrong severity.
 */
function describeWindow(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return "the last minute";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 45) return `the last ${plural(seconds, "second")}`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? "the last minute" : `the last ${plural(minutes, "minute")}`;
}

/**
 * Name what one sample shows. Order matters — the first matching rule wins.
 */
export function classifySteadyState(
  sample: ContainerStabilitySample,
  ctx: SteadyStateContext,
): SteadyStateVerdict {
  const detail = sample.errorLine?.trim() ? ` (${sample.errorLine.trim()})` : "";
  const exit = sample.exitCode;

  // `restarting` is docker mid-bounce. Unambiguous, and invisible to
  // `getContainerInfo` (which collapses it into `running` on purpose).
  if (sample.state === "restarting") {
    return {
      kind: "crash_loop",
      reason:
        `it is restarting${exit !== null ? ` after exiting with code ${exit}` : ""}${detail}`,
    };
  }

  // The delta rule. A container that restarted three times since the baseline is
  // looping regardless of what state we happened to catch it in — which is the
  // whole reason this is a poll and not an event stream: `RestartCount` is
  // monotonic, so nothing is missed between samples.
  if (ctx.prevRestartCount !== null) {
    const delta = sample.restartCount - ctx.prevRestartCount;
    if (delta >= CRASH_RESTART_DELTA) {
      return {
        kind: "crash_loop",
        reason:
          `it restarted ${plural(delta, "time")} in ${describeWindow(ctx.baselineAgeMs)}` +
          `${exit !== null ? ` (exit code ${exit})` : ""}${detail}`,
      };
    }
  }

  // Paused is only ever a human with a keyboard.
  if (sample.state === "paused") return ok("not_expected");

  if (sample.state === "exited" || sample.state === "dead") {
    // A one-shot that finished: exited clean and nothing will restart it. Same
    // call `classifyStability` makes with its `completed` verdict — a migration
    // job or an init container is not an outage.
    //
    // Requires a KNOWN zero. This used to read `exit ?? 0`, which turned "we never
    // got to inspect it" into "it finished successfully" — so a genuinely dead
    // container sampled from the container list (no exit code available there) was
    // reported healthy AND had its open incident closed with an "is back up".
    if (exit === 0 && !restartsAfter(sample.restartPolicy, exit)) return ok("healthy");

    // The operator stopped it. Checked AFTER the loop rules above so a service
    // that was stopped while already crash-looping still reports the loop.
    if (!ctx.expectRunning) return ok("not_expected");

    if (sample.state === "dead") {
      return {
        kind: "down",
        reason: `the container is in docker's "dead" state${detail}`,
      };
    }

    // Not running, expected up, and nothing to say why: a completed one-shot and a
    // crashed service look identical without the exit code. Opening on that pages
    // for finished migration jobs; closing on it hides real outages. So: neither.
    if (exit === null) return ok("unknown");

    return {
      kind: "down",
      reason:
        (sample.oomKilled
          ? `it was OOM-killed (exit code ${exit})`
          : `it exited with code ${exit}`) +
        (restartsAfter(sample.restartPolicy, exit) ? " and has not come back" : "") +
        detail,
    };
  }

  // Up, but its own healthcheck disagrees. `starting` is never an incident — that
  // is the grace period the healthcheck author asked for.
  if (sample.state === "running" && sample.health === "unhealthy") {
    return { kind: "unhealthy", reason: `its healthcheck reports unhealthy${detail}` };
  }

  // Created but never started. One tick of this is a race with a deploy; two is a
  // container that cannot start.
  if (sample.state === "created" && (ctx.createdTicks ?? 0) >= 1) {
    if (!ctx.expectRunning) return ok("not_expected");
    return { kind: "down", reason: `it was created but never started${detail}` };
  }

  if (sample.state === "running") return ok("healthy");

  // What's left proves nothing: `created` on its first tick (a race with a deploy),
  // `removing`, and a state string a future docker adds that we don't recognize.
  //
  // `missing` in particular is deliberately NOT an incident here — a container
  // absent from the host is indistinguishable from one being recreated mid-deploy,
  // and the sweep, which knows about in-flight deploys, is the only place with
  // enough context to make that call (see `missingContainerVerdict`).
  return ok("unknown");
}
