/**
 * Built-in connectivity checks. Self-register on import (like the backup
 * destination adapters), so any module that runs a check imports this file for
 * its side effect. Kept separate from the pure registry (`./connectivity`) so
 * the registry stays transport/env-free and unit-testable.
 *
 * We unify the CONTRACT, not the transport: each check uses whatever connection
 * fits — the cached `sshManager`/`SshExecutor` for management, the backup
 * adapter's own client for destinations (keeping heavy transfers off the shared
 * connection — the #34 isolation).
 */
import {
  createExecutor,
  isSshAuthError,
  resolveDestination,
  type BackupDestinationRow,
  type CommandExecutor,
  type SshConfig,
} from "@repo/adapters";
import { classifyConnectivityError, connFail, connOk, type ConnectivityResult } from "@repo/core";
import { registerConnectivityCheck } from "./connectivity";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";

const ECHO_TIMEOUT_MS = 15_000;

/** Shared SSH liveness proof: run a trivial echo and time the round-trip. */
async function sshEcho(executor: CommandExecutor): Promise<ConnectivityResult> {
  const startedAt = Date.now();
  const out = await executor.exec("echo ok", { timeout: ECHO_TIMEOUT_MS });
  if (out.trim() !== "ok") return connFail("protocol_error", "Unexpected response from host");
  return connOk(Date.now() - startedAt);
}

/** Turn a thrown SSH error into a result, preferring the precise auth signal. */
function sshError(err: unknown): ConnectivityResult {
  const { code, message } = classifyConnectivityError(err, isSshAuthError(err) ? "auth_failed" : undefined);
  return connFail(code, message);
}

/** Ad-hoc SSH from raw credentials (server add/edit + onboarding wizard). */
registerConnectivityCheck<SshConfig>("ssh", async (config) => {
  const executor = createExecutor(config);
  try {
    return await sshEcho(executor);
  } catch (err) {
    return sshError(err);
  } finally {
    await executor.dispose();
  }
});

/** A saved server by id — cheap TCP probe first, then an authenticated echo. */
registerConnectivityCheck<string>("ssh-server", async (serverId) => {
  const reachable = await sshManager.probeReachable(serverId).catch(() => false);
  if (!reachable) return connFail("unreachable", "Host is not reachable");
  try {
    return await sshManager.withExecutor(serverId, (e) => sshEcho(e));
  } catch (err) {
    return sshError(err);
  }
});

/** A backup destination (pre-resolved adapter row) — delegates to the adapter's
 *  own preflight (writes + deletes a probe), staying on its own connection. */
registerConnectivityCheck<BackupDestinationRow>("backup-destination", async (row) => {
  const startedAt = Date.now();
  const result = await resolveDestination(row).preflight();
  if (result.ok) return connOk(Date.now() - startedAt);
  const { code, message } = classifyConnectivityError(result.reason);
  return connFail(code, message);
});
