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
  // NOT "socket hang up": it is what an HTTP client reports for ANY far end that vanished
  // mid-request, including a permission-denied Docker socket and a wedged channel, neither
  // of which a fresh connection fixes. A match here makes `withExecutor` replay its whole
  // callback — and those callbacks install mail, create mailboxes and ensure the edge, so a
  // non-retryable cause becomes a repeated mutation. `core/connectivity.ts` labels it
  // without retrying, `api/lib/remote-state.ts` still maps it to a 503, and the bridge's
  // 502 carries the real reason — so leaving it out here costs no diagnosis.
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

/**
 * This instance cannot drive its host — host control is switched off, we are
 * containerized with no channel provisioned, or the channel is provisioned and
 * nothing gets through it. The first two are raised by `createHostExecutor()` at
 * CONSTRUCTION, deliberately: the alternative is running a host operation inside the
 * api container, against a filesystem that only looks like the host's.
 *
 * `unreachable` is the third state and it can only be established by dialing, so the
 * manager raises it at acquire time once it has watched the channel fail. Same class
 * because it is the same answer to the same question — and because the caller that
 * legitimately survives the other two survives this one for the same reason.
 *
 * Typed rather than a bare Error because exactly one caller legitimately survives
 * it — resolving a LOCAL server row, whose workload is reached through the mounted
 * Docker socket and needs no host access. That caller degrades to
 * `unavailableExecutor()`; every other caller lets this propagate.
 */
export class HostChannelUnavailableError extends Error {
  readonly code: "disabled" | "not_configured" | "unreachable";
  constructor(code: "disabled" | "not_configured" | "unreachable", message: string) {
    super(message);
    this.name = "HostChannelUnavailableError";
    this.code = code;
  }
}

export function isHostChannelUnavailableError(
  err: unknown,
): err is HostChannelUnavailableError {
  return (
    err instanceof HostChannelUnavailableError ||
    (err instanceof Error && err.name === "HostChannelUnavailableError")
  );
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

const MAX_COMMAND_CHARS = 120;

/**
 * A command, bounded, for putting in an error message.
 *
 * The environment probe is one ~3KB shell script, and a timeout used to render it verbatim
 * into the error → `probeError` → `assessHostSupport`, which quoted it back at the operator
 * as the thing the host had said. Our own input presented as the host's answer is worse than
 * no detail at all: it is the exact misattribution the three-outcome probe split exists to
 * remove. Bounded rather than dropped because for the short commands — which is nearly all
 * of them — the command IS the useful part of a timeout.
 */
export function commandForError(command: string): string {
  const oneLine = command.trim().replace(/\s+/g, " ");
  return oneLine.length > MAX_COMMAND_CHARS
    ? `${oneLine.slice(0, MAX_COMMAND_CHARS)}… (${command.length} chars)`
    : oneLine;
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