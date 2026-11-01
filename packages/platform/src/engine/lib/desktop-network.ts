import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { networkInterfaces } from "node:os";
import { peekPlatform } from "@repo/adapters";

/**
 * An offline desktop cannot observe its remote servers. Check the machine that
 * owns the SSH connections, not the browser viewing its dashboard.
 *
 * An assigned external interface only means connectivity is POSSIBLE: VPNs,
 * captive portals and a lost upstream link can still prevent a connection. In
 * that case the normal server probe remains authoritative. No public Internet
 * endpoint is required, so isolated LANs keep working.
 */
export function desktopNetworkDisconnected(): boolean {
  // Cached issue feeds also work before host adapters are initialized. Without
  // a desktop observer, local network state is unknown rather than offline.
  if (peekPlatform()?.target !== "desktop") return false;
  try {
    return !Object.values(networkInterfaces()).some((addresses) =>
      addresses?.some((address) => !address.internal),
    );
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/desktop-network");
    // Failure to inspect this machine is not evidence that any server is down.
    return false;
  }
}
