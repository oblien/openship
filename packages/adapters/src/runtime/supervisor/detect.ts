/**
 * Supervisor detection - pick the best process supervisor for the target.
 *
 * Probes the target machine (via executor) and returns:
 *   - SystemdSupervisor when systemd is running and its services can be managed
 *   - NohupSupervisor otherwise (macOS, OpenRC, minimal containers)
 *
 * The result is determined by the TARGET machine, not the host running
 * the API (e.g. macOS API → SSH to Linux server → systemd).
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { safeErrorMessage } from "@repo/core";

import type { CommandExecutor } from "../../types";
import type { ProcessSupervisor } from "./types";
import { systemDebug } from "../../system/debug";
import { resolveEnvironment } from "../../system/environment";
import { privilegedExecutor } from "../../system/privilege";
import { SystemdSupervisor } from "./systemd";
import { NohupSupervisor } from "./nohup";

/**
 * Detect and create the appropriate supervisor for the given executor.
 *
 * Called once when constructing a BareRuntime. The probe itself is the shared
 * `resolveEnvironment` one, memoized per executor, so this costs no round-trip of its own
 * on a target anything else has already looked at.
 *
 * Its two-condition systemd test — PID 1 is systemd *and* `systemctl` exists, because a
 * container can have the binary with no running init and a minimal install can have the
 * init with no binary — is the one the detector now applies for every caller. There used
 * to be three different tests in the repo and this was the correct one.
 *
 * Falling back to nohup when the answer is unknown is deliberate and safe — nohup works
 * everywhere — but it is not free: the workload stops surviving a reboot. So the fallback
 * is never silent when it was taken for lack of an answer rather than because the box
 * genuinely runs no systemd. That distinction was invisible before: an unmeasured host
 * reports `serviceManager: "none"`, which reads exactly like a measured macOS box.
 */
export async function detectSupervisor(
  executor: CommandExecutor,
  workDir: string,
): Promise<ProcessSupervisor> {
  const profile = await resolveEnvironment(executor).catch((err: unknown) => {
    observeCaughtError(err, "adapters/runtime/supervisor/detect");
    // Unreachable box: the supervisor choice is moot, since the next command fails too.
    systemDebug("supervisor", `detect: host unreachable, using nohup — ${safeErrorMessage(err)}`);
    return null;
  });

  let fallbackReason =
    profile?.probeError ?? (profile?.supported === false ? profile.unsupportedReason : null);
  if (profile?.serviceManager === "systemd") {
    // A running init does not grant this login access to /etc/systemd/system.
    // Reuse the host privilege gate: root stays unchanged, passwordless sudo
    // manages system services, and an unprivileged SDK/desktop login uses nohup.
    const grant = await privilegedExecutor(executor, "Managing application services", {
      onRefusedHost: "proceed",
    });
    if (grant.supported && grant.value.elevation !== "none") {
      // Omitting User for an unidentified non-root login would run its app as root.
      if (profile.isRoot || profile.loginUser) {
        return new SystemdSupervisor(grant.value.executor, workDir, {
          artifactExecutor: executor,
          user: profile.isRoot ? undefined : profile.loginUser,
        });
      }
      fallbackReason = "Could not identify the login user for the application service";
    } else {
      fallbackReason = grant.supported
        ? "Managing application services needs root or passwordless sudo"
        : grant.reason;
    }
  }

  if (fallbackReason) {
    errorDiagnostics.warn("adapters/runtime/supervisor/detect",
      `[supervisor] the service will run under nohup and will NOT restart after a reboot: ${fallbackReason}`,
    );
  }

  return new NohupSupervisor(executor, workDir);
}
