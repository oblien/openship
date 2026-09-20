/**
 * Deploy entry point — Desktop-only.
 *
 * Lets a SERVER build clone on a self-hosted server using the operator's local
 * `gh` identity (no build-local-then-upload), without persisting any token on
 * the build host. Opens the relay + drops the helper script; the adapters clone
 * step points git at the helper via `GIT_CONFIG_*` over a plain URL.
 *
 * Used by the build pipeline as a fallback when no App/PAT token is available
 * and the target server opted into credential forwarding. See ./README.md.
 */
import type { CommandExecutor } from "@repo/adapters";
import { openRelay, writeHelperScript } from "./relay";

/**
 * Open a relay against a server AND drop the helper script. Returns the script
 * path + a combined teardown (remove the remote script, then close the reverse
 * tunnel + release the SSH hold). Returns `null` on the system-ssh / agent-auth
 * path (no reverse tunnel) so the caller can fall back / error clearly.
 *
 * Pass `expectedOwner` / `expectedRepo` (the deploy's repo) to repo-pin the
 * relay — it then serves credentials only for that one repo.
 */
export async function openDeployRelay(opts: {
  serverId: string;
  executor: CommandExecutor;
  sessionId: string;
  expectedOwner?: string;
  expectedRepo?: string;
}): Promise<{ scriptPath: string; close: () => Promise<void> } | null> {
  const relay = await openRelay({
    serverId: opts.serverId,
    sessionId: opts.sessionId,
    expectedOwner: opts.expectedOwner,
    expectedRepo: opts.expectedRepo,
  });
  if (!relay) return null;

  let scriptPath: string;
  try {
    scriptPath = await writeHelperScript(opts.executor, opts.sessionId, relay.port, relay.nonce);
  } catch (err) {
    await relay.close().catch(() => {});
    throw err;
  }

  return {
    scriptPath,
    close: async () => {
      // Remove the remote script while the connection is still held by the
      // relay retain, then close the tunnel + release.
      await Promise.resolve(opts.executor.rm(scriptPath)).catch(() => {});
      await relay.close().catch(() => {});
    },
  };
}
