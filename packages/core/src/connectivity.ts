/**
 * One shared contract for every "can we reach/authenticate/use this target"
 * check — SSH servers, backup destinations, and future kinds (cluster nodes,
 * networking endpoints, mail servers). Backend checks produce a
 * `ConnectivityResult`; the frontend renders it by `code`.
 *
 * Pure and dependency-free: importable from the API, adapters, and the
 * dashboard alike. It classifies the *shape* of a failure; it never opens a
 * connection itself (that's each check's job, on whatever transport fits).
 */

/** Coarse failure class, stable across transports so UIs can map copy once. */
export type ConnectivityCode =
  | "reachable" // ok
  | "unreachable" // TCP/host down, refused, timed out, no route
  | "auth_failed" // reached the service, credentials rejected
  | "permission_denied" // authed, but not allowed to do the thing (e.g. write path)
  | "timeout" // operation exceeded its deadline
  | "protocol_error" // reached it, but the exchange failed (bad handshake / unexpected reply)
  | "misconfigured" // caller-side config is invalid / incomplete (no host, no server row)
  | "unknown";

export interface ConnectivityResult {
  ok: boolean;
  code: ConnectivityCode;
  /** Human-readable, safe to show; already trimmed. */
  message: string;
  /** Round-trip of the successful check, when measured. */
  latencyMs?: number;
}

export function connOk(latencyMs?: number, message = "Connection successful"): ConnectivityResult {
  return { ok: true, code: "reachable", message, ...(latencyMs != null ? { latencyMs } : {}) };
}

export function connFail(code: ConnectivityCode, message: string): ConnectivityResult {
  return { ok: false, code, message: message.trim() || "Connection failed" };
}

/** Optional server-supplied tag → code. Keeps the historical wire tags working. */
const TAG_TO_CODE: Record<string, ConnectivityCode> = {
  auth_failed: "auth_failed",
  connection_failed: "unreachable",
  no_server: "misconfigured",
  permission_denied: "permission_denied",
  timeout: "timeout",
  protocol_error: "protocol_error",
};

// Ordered most-specific → least. Matched against the lowercased message.
const MESSAGE_PATTERNS: Array<[RegExp, ConnectivityCode]> = [
  // Filesystem errno codes first: Node spells EACCES as "EACCES: permission
  // denied, <syscall> '<path>'", which the auth rule below would otherwise
  // claim via its bare "permission denied" token — telling an operator their
  // credentials were rejected when the real fix is chmod/chown on the path.
  // Matching the errno (never present in SSH's "Permission denied (publickey)")
  // keeps the two apart.
  [/eacces|erofs/i, "permission_denied"],
  [/all configured authentication methods failed|permission denied|publickey|password rejected|authentication failed|auth fail/i, "auth_failed"],
  [/econnrefused|connection refused|ehostunreach|enetunreach|no route to host|host unreachable|enotfound|getaddrinfo|dns/i, "unreachable"],
  [/etimedout|timed out|timeout|keepalive timeout/i, "timeout"],
  [/econnreset|connection reset|connection lost|connection closed|handshake failed|not connected|channel open failure|open failed|unexpected response/i, "protocol_error"],
  [/eacces|permission denied|not permitted|access denied|forbidden|read-only|not writable/i, "permission_denied"],
];

function messageOf(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const m = (input as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(input ?? "");
}

/**
 * Classify an error (or message) into a `{ code, message }`. A caller-supplied
 * `tag` (historical wire value or a precise server-side determination like
 * `isSshAuthError`) always wins over the substring heuristics.
 */
export function classifyConnectivityError(
  input: unknown,
  tag?: string,
): { code: ConnectivityCode; message: string } {
  const message = messageOf(input).trim() || "Connection failed";
  if (tag && TAG_TO_CODE[tag]) return { code: TAG_TO_CODE[tag], message };
  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return { code, message };
  }
  return { code: "unknown", message };
}
