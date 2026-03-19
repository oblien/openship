/**
 * Supervisor detection — pick the best process supervisor for the target.
 *
 * Probes the target machine (via executor) and returns:
 *   - SystemdSupervisor if `systemctl` is available (Linux servers)
 *   - NohupSupervisor as fallback (macOS, minimal containers)
 *
 * The result is determined by the TARGET machine, not the host running
 * the API (e.g. macOS API → SSH to Linux server → systemd).
 */

import type { CommandExecutor } from "../../types";
import type { ProcessSupervisor } from "./types";
import { SystemdSupervisor } from "./systemd";
import { NohupSupervisor } from "./nohup";

/**
 * Detect and create the appropriate supervisor for the given executor.
 *
 * Called once when constructing a BareRuntime — the result is cached
 * for the lifetime of the runtime instance.
 */
export async function detectSupervisor(
  executor: CommandExecutor,
  workDir: string,
): Promise<ProcessSupervisor> {
  const hasSystemd = await probeSystemd(executor);
  if (hasSystemd) {
    return new SystemdSupervisor(executor, workDir);
  }
  return new NohupSupervisor(executor, workDir);
}

/**
 * Check if systemd is the active init system AND systemctl is usable.
 *
 * We check both because:
 *   - Some containers have systemctl but no running systemd (PID 1 isn't systemd)
 *   - Some minimal installs have systemd as PID 1 but no systemctl binary
 */
async function probeSystemd(executor: CommandExecutor): Promise<boolean> {
  try {
    // Check that PID 1 is systemd AND systemctl is available
    const result = await executor.exec(
      `[ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && echo y || echo n`,
    );
    return result.trim() === "y";
  } catch {
    return false;
  }
}
