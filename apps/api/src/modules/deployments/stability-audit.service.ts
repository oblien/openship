/**
 * Post-deploy stabilization audit — the gate between "the container was
 * created" and "the deployment is ready".
 *
 * Container-create success used to BE the success signal, which made a deploy
 * report `ready` (`successfulServices: 1`) while its only service was in a
 * restart loop: every point-in-time read shows "Up 1 second" because docker had
 * just restarted it again. This watches each container it was handed for a short
 * window and returns a verdict per container, with the exit code and last log
 * lines already folded in — so the failure is diagnosable from the deployment
 * record instead of needing an SSH round-trip to the box.
 *
 * Advisory about ITS OWN failures, decisive about the workload's: a runtime that
 * can't be sampled (no probe, unreachable host) yields NO finding, so an
 * unverifiable deploy behaves exactly as it did before this existed. Only a
 * conclusive reading fails a service.
 */

import { repos } from "@repo/db";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import {
  watchContainerStability,
  type BuildLogger,
  type RuntimeAdapter,
  type StabilityVerdict,
} from "@repo/adapters";

import * as sessionManager from "./session-manager";

/** One workload to watch. `serviceName` is only ever a label for messages. */
export interface StabilityTarget {
  serviceId?: string;
  serviceName: string;
  containerId: string;
  /**
   * `Date.now()` when this container was started, on THIS process's clock.
   * Credited against the window so a stack's earlier services don't get watched
   * for another full window. Omit and the container is watched from scratch.
   */
  startedAtMs?: number;
}

export interface StabilityFinding {
  target: StabilityTarget;
  verdict: StabilityVerdict;
  /** One line — the headline for SSE, step events, and the deployment error. */
  summary: string;
  /** Headline + the container's last log lines; persisted as `errorMessage`. */
  detail: string;
}

/** Keep one runaway log line from eating the whole error message. */
const MAX_LOG_LINE = 200;

function shorten(line: string): string {
  const clean = line.replace(/\s+$/, "");
  return clean.length > MAX_LOG_LINE ? `${clean.slice(0, MAX_LOG_LINE)}…` : clean;
}

/**
 * Last log lines from a container, newest last. Best-effort: an unreadable log
 * stream must not change the verdict, so it degrades to an empty tail.
 *
 * Exported for the steady-state health watch, which needs the identical excerpt
 * for its incident alerts — the log tail an operator reads at 3am should be the
 * same shape as the one attached to a failed deploy.
 */
export async function readLogTail(
  runtime: RuntimeAdapter,
  containerId: string,
  lines: number,
): Promise<string[]> {
  try {
    const entries = await runtime.getRuntimeLogs(containerId, lines);
    return entries
      .map((entry) => shorten(entry.message))
      .filter((message) => message.length > 0)
      .slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Watch every target for the stabilization window (concurrently — the window is
 * wall-clock, so N containers cost the same as one) and return a finding per
 * container whose outcome was CONCLUSIVE.
 *
 * `ok` findings are returned too: they carry the "restarted twice before
 * settling" warning, which callers surface without failing anything. Callers
 * that only care about failures filter on `!finding.verdict.ok`.
 *
 * Never throws.
 */
export async function verifyDeployedContainers(
  runtime: RuntimeAdapter,
  targets: StabilityTarget[],
  logger: BuildLogger,
  opts?: { windowMs?: number; pollMs?: number },
): Promise<StabilityFinding[]> {
  const sampler = runtime.sampleStability?.bind(runtime);
  if (!sampler || !runtime.supports("stabilityProbe") || targets.length === 0) return [];

  const windowMs = opts?.windowMs ?? SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS;
  const pollMs = opts?.pollMs ?? SYSTEM.DEPLOYMENTS.STABILIZE_POLL_MS;
  logger.log(
    `Verifying ${targets.length === 1 ? "the container" : `${targets.length} containers`} ` +
      `stayed up (${Math.round(windowMs / 1000)}s stabilization window)…\n`,
  );

  const settled = await Promise.all(
    targets.map(async (target): Promise<StabilityFinding | null> => {
      let verdict: StabilityVerdict;
      try {
        verdict = await watchContainerStability(
          { sample: () => sampler(target.containerId) },
          {
            windowMs,
            pollMs,
            crashRestarts: SYSTEM.DEPLOYMENTS.STABILIZE_CRASH_RESTARTS,
            alreadyRunningMs: target.startedAtMs ? Math.max(0, Date.now() - target.startedAtMs) : 0,
          },
        );
      } catch (err) {
        // Couldn't read the runtime (dropped SSH channel, daemon hiccup). That
        // is a gap in OUR knowledge, not a failed workload — say so and leave
        // the service's status exactly as the deploy set it.
        logger.log(
          `Couldn't verify "${target.serviceName}" stayed up (${safeErrorMessage(err)}) — ` +
            `leaving its deploy result unchanged.\n`,
          "warn",
          { serviceName: target.serviceName },
        );
        return null;
      }

      if (verdict.ok) {
        if (verdict.warning) {
          logger.log(`Service "${target.serviceName}": ${verdict.warning}.\n`, "warn", {
            serviceName: target.serviceName,
          });
        }
        return {
          target,
          verdict,
          summary: verdict.warning ?? verdict.reason,
          detail: verdict.warning ?? verdict.reason,
        };
      }

      const tail = await readLogTail(
        runtime,
        target.containerId,
        SYSTEM.DEPLOYMENTS.STABILIZE_LOG_TAIL_LINES,
      );
      const summary =
        `"${target.serviceName}" did not stay up: ${verdict.reason}` +
        (verdict.oomKilled ? " — the container was OOM-killed" : "");
      const detail = tail.length > 0 ? `${summary}\nLast log lines:\n${tail.join("\n")}` : summary;

      // The full tail goes to the build log as well: the error message is capped
      // for the DB, the stream is where the operator reads the crash.
      logger.log(`${summary}\n`, "error", { serviceName: target.serviceName });
      if (tail.length > 0) {
        logger.log(
          `Last ${tail.length} log line${tail.length === 1 ? "" : "s"} from "${target.serviceName}":\n` +
            `${tail.join("\n")}\n`,
          "error",
          { serviceName: target.serviceName },
        );
      }

      return { target, verdict, summary, detail };
    }),
  );

  return settled.filter((finding): finding is StabilityFinding => finding !== null);
}

/**
 * Record the failed findings: flip each service's `service_deployment` row to
 * `failure` with the exit code + log tail, and tell the live build stream. The
 * rollup in finalizeComposeDeploy reads those rows, so this is what turns a
 * crash loop into `partial_failure` / `failed` instead of a green deploy.
 *
 * Split from the watch (and from the caller's deploy loop) so the persistence
 * lives in one place: the caller only reconciles its own in-memory result set
 * from the returned ids.
 *
 * Returns serviceId → finding for the services that were demoted.
 */
export async function recordUnstableServices(opts: {
  deploymentId: string;
  findings: StabilityFinding[];
  logger: BuildLogger;
}): Promise<Map<string, StabilityFinding>> {
  const { deploymentId, findings, logger } = opts;
  const unstable = findings.filter((finding) => !finding.verdict.ok && finding.target.serviceId);
  const demoted = new Map<string, StabilityFinding>();
  if (unstable.length === 0) return demoted;

  const rows = await repos.serviceDeployment.listByDeployment(deploymentId).catch(() => []);
  for (const finding of unstable) {
    const serviceId = finding.target.serviceId!;
    demoted.set(serviceId, finding);

    const row = rows.find((r) => r.serviceId === serviceId);
    if (row) {
      await repos.serviceDeployment
        .update(row.id, {
          status: "failure",
          errorMessage: finding.detail,
          error: finding.summary,
          finishedAt: new Date(),
        })
        .catch((err) =>
          logger.log(
            `Warning: couldn't record the failed stabilization for "${finding.target.serviceName}": ${safeErrorMessage(err)}\n`,
            "warn",
          ),
        );
    }
    sessionManager.broadcastServiceStatus(deploymentId, {
      serviceName: finding.target.serviceName,
      serviceId,
      status: "failed",
      error: finding.summary,
    });
  }
  return demoted;
}
