import type { RuntimeMode } from "@repo/core";

/**
 * Pure topology rule for target-host source acquisition. Bare builds execute
 * through the target command executor. Docker can acquire source there only on
 * a remote SSH server; "This Server" uses the API host's socket transport,
 * whose source staging runs in the API process.
 */
export function targetSourceCloneSupportedForTopology(
  runtimeMode: RuntimeMode,
  isLocalServer: boolean,
): boolean {
  return runtimeMode === "bare" || (runtimeMode === "docker" && !isLocalServer);
}
