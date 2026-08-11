const SSH_AUTH_ERROR_PATTERNS = [
  "All configured authentication methods failed",
];

const RETRYABLE_CONNECTION_ERROR_PATTERNS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "Timed out",
  "Not connected",
  "Connection lost",
  "read ECONNRESET",
  "Handshake failed",
  "keepalive timeout",
  "SSH connection closed before ready",
  // ssh2 emits "Channel open failure: open failed" / "Channel open failure: …"
  // when the SSH SERVER refuses a new channel - typically because the cached
  // connection has gone half-dead (peer-side LOGOUT, network blip,
  // remote sshd MaxSessions). The inner SshExecutor retries `exec`/
  // `streamExec` on this, but `pipeLocal`, `transferIn`, and any other
  // channel-bearing op bubble it up. Listing it here lets `withExecutor`
  // drop the dead connection and retry transparently - fixes the
  // "first redeploy fails, second click works" pattern.
  "Channel open failure",
  "open failed",
];

/**
 * Thrown when an in-flight command is aborted because the SSH transport itself
 * dropped (socket close/end/error) — as opposed to a per-command timeout or a
 * non-zero exit. Lets the manager react immediately (reconnect / re-drive a
 * journaled op) instead of waiting out the 30s command timeout while the op
 * hangs on a dead channel. Treated as a retryable connection error below.
 */
export class SshDisconnectedError extends Error {
  constructor(message = "SSH connection lost") {
    super(message);
    this.name = "SshDisconnectedError";
  }
}

export function isSshDisconnectedError(err: unknown): err is SshDisconnectedError {
  // instanceof for same-realm throws; name check survives a structured-clone /
  // re-thrown copy that lost its prototype across a boundary.
  return (
    err instanceof SshDisconnectedError ||
    (err instanceof Error && err.name === "SshDisconnectedError")
  );
}

export function isSshAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return SSH_AUTH_ERROR_PATTERNS.some((pattern) => err.message.includes(pattern));
}

export function isRetryableRemoteConnectionError(err: unknown): boolean {
  // A detected transport drop is by definition a retryable connection error.
  if (isSshDisconnectedError(err)) return true;
  if (!(err instanceof Error)) return false;
  return RETRYABLE_CONNECTION_ERROR_PATTERNS.some((pattern) =>
    err.message.includes(pattern),
  );
}

export function isRemoteConnectionError(err: unknown): boolean {
  return isSshAuthError(err) || isRetryableRemoteConnectionError(err);
}

/**
 * Detect "resource not found" errors from a runtime SDK (dockerode et al.).
 * The Docker daemon returns HTTP 404 for missing containers/images/volumes/
 * networks; dockerode surfaces this as an Error with `.statusCode === 404`
 * (message containing "no such container/image/..."). Used to distinguish
 * ABSENT (resource already gone → idempotent success / drift) from
 * UNREACHABLE (server down → retry) and from a real error.
 */
export function isRuntimeNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode === 404) return true;
  return (
    typeof e.message === "string" &&
    /no such (container|image|volume|network)/i.test(e.message)
  );
}