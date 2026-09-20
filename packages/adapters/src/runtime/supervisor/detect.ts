/**
 * Supervisor detection - pick the best process supervisor for the target.
 *
 * Probes the target machine (via executor) and returns:
 *   - SystemdSupervisor when systemd is the running init and systemctl is usable
 *   - NohupSupervisor otherwise (macOS, OpenRC, minimal containers)
 *
 * The result is determined by the TARGET machine, not the host running
 * the API (e.g. macOS API → SSH to Linux server → systemd).
 */

import { safeErrorMessage } from "@repo/core";

import type { CommandExecutor } from "../../types";
import type { ProcessSupervisor } from "./types";
import { systemDebug } from "../../system/debug";
import { resolveEnvironment } from "../../system/environment";
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
    // Unreachable box: the supervisor choice is moot, since the next command fails too.
    systemDebug("supervisor", `detect: host unreachable, using nohup — ${safeErrorMessage(err)}`);
    return null;
  });

  if (profile?.serviceManager === "systemd") return new SystemdSupervisor(executor, workDir);

  const unmeasured = profile?.probeError ?? (profile?.supported === false ? profile.unsupportedReason : null);
  if (unmeasured) {
    console.warn(
      `[supervisor] could not confirm this host's init system, so the service will run under ` +
        `nohup and will NOT restart after a reboot: ${unmeasured}`,
    );
  }

  return new NohupSupervisor(executor, workDir);
}
