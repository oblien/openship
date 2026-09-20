/**
 * "Did the thing we just deployed answer?" — ONE implementation, for every deploy shape.
 *
 * It exists because the answer depends on two decisions that are easy to get subtly
 * wrong, and were:
 *
 *   1. WHICH ADDRESS. A published candidate lives at `127.0.0.1:<hostPort>`; a container
 *      with no published port lives at its bridge IP. `resolveReadinessTarget` owns that.
 *   2. WHICH MACHINE DIALS. The address above only means the right thing from the DEPLOY
 *      TARGET. A containerized API has its own namespace, and a remote-server deploy's
 *      target isn't this box at all — so `127.0.0.1` here is a different computer's
 *      loopback. Using the local host channel for a remote deploy can false-NEGATIVE
 *      (nothing on that port locally → a healthy deploy destroyed) or, worse,
 *      false-POSITIVE (some unrelated local service answers → a broken deploy reported
 *      healthy). The rule is the one the host-port allocator two hundred lines away
 *      already follows: the deploy's own executor when it has one, else the pooled host
 *      channel.
 *
 * The single-app pipeline and the compose per-service loop both go through here so those
 * two decisions cannot drift apart — a hand-derived second copy is exactly the class of
 * divergence that produced GH-583.
 */

import type { CommandExecutor, RuntimeAdapter } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

import { sshManager } from "../../lib/ssh-manager";
import { waitForReadyFromExecutor } from "./forwarded-readiness";
import { resolveReadinessTarget } from "./readiness-target";
import type { ResolvedReadinessGate } from "./readiness-gate";

export interface ReadinessProbeVerdict {
  /** Operator-facing failure detail, or null when the probe passed. */
  failure: string | null;
  /**
   * Set when the probe could not RUN. The verdict is unknown, so the caller must warn
   * and leave the deploy alone — failing here destroys deployments that were fine, which
   * is the bug this module was written to close.
   */
  skipped?: string;
}

/**
 * Dial a just-deployed workload and say whether it answered.
 *
 * Never throws: a probe is a diagnostic, and every way it can fail to reach a verdict
 * comes back as `skipped` rather than as an exception or a false failure.
 */
export async function probeDeployedReadiness(args: {
  runtime: RuntimeAdapter;
  containerId: string;
  /** The workload's own port — what a wrong-port failure should name. */
  primaryPort: number;
  probe: ResolvedReadinessGate["probe"];
  /** The deploy target's executor; null falls back to the pooled local host channel. */
  targetExecutor: CommandExecutor | null;
  log: (message: string, level?: "info" | "warn") => void;
  /** "the app", or a service name — whatever the message should call this workload. */
  subject?: string;
}): Promise<ReadinessProbeVerdict> {
  const { runtime, containerId, primaryPort, probe, targetExecutor, log } = args;
  const subject = args.subject ?? "the app";

  const { host, port } = await resolveReadinessTarget({
    runtime,
    containerId,
    primaryPort,
    probePort: probe.port,
  });
  // Name the address actually dialed. Reporting `primaryPort` here sent operators to look
  // at the app's own port (3000) when the probe had really been talking to the published
  // host port, so a wrong-port or unreachable-address failure read as "my app is broken".
  const target = `${host}:${port}${probe.path ?? ""}`;
  const seconds = Math.round(probe.timeoutMs / 1000);
  log(
    `Health check: waiting up to ${seconds}s for ${subject} to answer at ${target}` +
      `${probe.path ? "" : " (TCP connect)"}…\n`,
  );

  const opts = {
    path: probe.path,
    timeoutMs: probe.timeoutMs,
    intervalMs: probe.intervalMs,
  };

  let result: Awaited<ReturnType<typeof waitForReadyFromExecutor>>;
  try {
    result = targetExecutor
      ? await waitForReadyFromExecutor(targetExecutor, host, port, opts)
      : await sshManager.withHostExecutor((executor) =>
          waitForReadyFromExecutor(executor, host, port, opts),
        );
  } catch (error) {
    // Reaching the machine that should dial is itself a "couldn't ask", not a verdict on
    // the workload — so it warns instead of failing the deploy.
    return {
      failure: null,
      skipped:
        `could not probe ${target} from the deployment host: ${safeErrorMessage(error)}. ` +
        `Check the host-control channel.`,
    };
  }

  if (result.unverifiable) {
    return {
      failure: null,
      skipped:
        `${result.unverifiable}. Re-run \`openship up\` to re-provision the host channel, ` +
        `then redeploy to have this checked.`,
    };
  }

  // Named on both verdicts once it isn't the normal path: a `curl`-on-the-host answer has
  // slightly different semantics (see waitForReadyFromExecutor), and an operator reading
  // either outcome should know the channel needs re-provisioning rather than wonder why
  // the wording changed.
  const viaNote =
    result.via === "exec"
      ? " (probed with `curl` on the host — this channel refuses port forwarding; " +
        "re-run `openship up` to re-provision it)"
      : "";

  if (!result.ready) {
    return {
      failure:
        `${subject} never answered at ${target} within ${seconds}s` +
        `${probe.path ? " (or answered 500+)" : ""}${viaNote}. It may have crashed on startup, ` +
        `may still be booting, or may be listening on a different port than ${primaryPort} ` +
        `— check the runtime logs.`,
    };
  }

  log(`Health check passed: ${subject} answered at ${target}${viaNote}.\n`);
  return { failure: null };
}
