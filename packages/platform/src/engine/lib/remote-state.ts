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
    // A serialized SshExecRequestError loses its type at result boundaries.
    // Match ssh2's complete sentinel only; remote stderr such as "unable to
    // execute helper" is an operation failure, not lost connectivity.
    msg === "unable to exec" ||
    // Deliberately here and NOT in the adapters' retryable set, because the two lists
    // answer different questions. "Did we reach the host?" — no, so a 503 naming the
    // target beats a 500 blaming the request. "Should we run the whole callback again?" —
    // no: an HTTP client says this for any far end that vanished mid-request, including a
    // permission-denied Docker socket, and those callbacks install mail and ensure the
    // edge, so replaying one turns a non-retryable cause into a repeated mutation.
    msg.includes("socket hang up") ||
    msg.includes("connection lost") ||
    msg.includes("not connected") ||
    msg.includes("connection closed before ready")
  );
}

/** True when an error means the remote resource is already gone (404). */
export function isAbsent(err: unknown): boolean {
  return isRuntimeNotFoundError(err);
}

/**
 * True when the runtime REFUSED a state change because the resource is already in
 * that state — Docker answers 304 to stopping a stopped container or starting a
 * running one.
 *
 * Belongs with the other two classifiers because it is the fourth answer a state
 * change can give, and it is an idempotent SUCCESS: a pause that stops four of a
 * project's five containers and finds the fifth already down has done its job.
 * Callers that swallowed every error to get this behaviour also swallowed
 * "unreachable", which is how a failed pause reported success.
 */
export function isAlreadyInState(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { statusCode?: number }).statusCode === 304) {
    return true;
  }
  return /already (stopped|started|running|paused|in progress)/i.test(safeErrorMessage(err));
}
