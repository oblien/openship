/**
 * Three-state model for remote operations: a server/resource is either
 * PRESENT, ABSENT (deleted out-of-band), or UNREACHABLE (network/SSH down).
 * Confusing these is the root of the delete-hang, false-failed-deploy, and
 * invisible-drift bugs — every remote op should branch on this distinction.
 *
 *   - present     → operate normally.
 *   - absent      → idempotent success (delete) / drift flag (inspect).
 *   - unreachable → don't hang, don't finalize; orphan (delete) or leave
 *                   `reconciling` and retry (deploy).
 */
import { isRemoteConnectionError, isRuntimeNotFoundError } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

export type RemoteState = "present" | "absent" | "unreachable";

/**
 * True when an error means "couldn't reach the remote" (network/SSH/timeout)
 * as opposed to a real operation failure. Reuses the adapter connection
 * classifier and additionally matches the executor's lowercase command-timeout
 * string ("Command timed out after Nms"), which `isRemoteConnectionError`
 * misses (it only matches capital-T "Timed out" / ETIMEDOUT).
 */
export function isConnectionLoss(err: unknown): boolean {
  // Fast path for Error instances (reuses the adapter classifier).
  if (isRemoteConnectionError(err)) return true;
  // Message-string fallback so this also works when the caller passes a bare
  // string (e.g. deployResult.error), which `isRemoteConnectionError` ignores
  // because it requires `err instanceof Error`. Covers the stale-connection
  // "Channel open failure: open failed" and the lowercase command-timeout.
  const msg = safeErrorMessage(err).toLowerCase();
  return (
    /timed out|timeout|etimedout|econnreset|econnrefused|ehostunreach|enetunreach/.test(msg) ||
    msg.includes("channel open failure") ||
    msg.includes("open failed") ||
    msg.includes("connection lost") ||
    msg.includes("not connected") ||
    msg.includes("connection closed before ready")
  );
}

/** True when an error means the remote resource is already gone (404). */
export function isAbsent(err: unknown): boolean {
  return isRuntimeNotFoundError(err);
}
