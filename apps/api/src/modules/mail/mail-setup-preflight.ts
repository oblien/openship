/**
 * "Can this install even start?" — the check that has to happen BEFORE
 * `POST /mail/setup` becomes an SSE stream.
 *
 * That endpoint's response body IS the progress stream, so the moment
 * `streamSSE` flushes headers the request is a 200 forever, whatever happens
 * next. #492 hit the consequence: a host executor that answered every command
 * with `Permission denied` produced a 200, an SSE `error` frame the wizard had
 * nowhere to render, and an empty form — the real cause was visible only in the
 * api container's logs. A failure that means "nothing was attempted" belongs in
 * the status code, and the only place to decide that is here, before the stream.
 *
 * Deliberately reuses the shared connectivity registry (`ssh-server`: TCP probe
 * then an authenticated `echo ok` through the same pooled executor the install
 * drives) rather than inventing a second notion of "server is usable".
 */
import { runConnectivityCheck } from "../../lib/connectivity";
import "../../lib/connectivity-checks"; // registers the ssh-server check used below
import type { ConnectivityCode } from "@repo/core";

export interface MailSetupPreflightFailure {
  /** Operator-facing: names the host's own reason and what to do about it. */
  error: string;
  /** Machine-readable cause from the connectivity registry. */
  code: ConnectivityCode;
}

/**
 * Prove the SSH channel the install runs on. Resolves `null` when setup may
 * start, or the failure to return verbatim as a non-2xx body.
 */
export async function preflightMailSetup(
  serverId: string,
): Promise<MailSetupPreflightFailure | null> {
  const result = await runConnectivityCheck("ssh-server", serverId);
  if (result.ok) return null;
  return {
    code: result.code,
    error:
      `Can't start mail setup: ${result.message}. Openship could not run a single ` +
      "command on this server, so nothing was attempted — fix the server's SSH " +
      "connection and start setup again.",
  };
}
