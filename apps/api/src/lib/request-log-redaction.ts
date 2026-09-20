/**
 * Keep bearer credentials out of request diagnostics.
 *
 * Query strings are never useful enough in an access log to justify retaining
 * their common secrets (OAuth codes, tokens, signed URLs). Invitation claim ids
 * also live in the URL path, so redact those explicit bearer-token segments.
 */
const INVITATION_BEARER_PATH = /(\/api\/auth\/invitation-preview\/|\/accept-invite\/)[^/?#\s]+/g;

export function redactSensitiveRequestPath(value: string): string {
  return value.replace(INVITATION_BEARER_PATH, "$1:token");
}

/** Sanitize one line emitted by Hono's request logger. */
export function sanitizeRequestLogLine(line: string): string {
  // Hono emits `<-- METHOD /path?query` and
  // `--> METHOD /path?query STATUS DURATION`. Remove the complete query before
  // applying path-token redaction; the status/duration suffix remains intact.
  const withoutQuery = line.replace(/(\s\/[^?\s]*)\?[^\s]*/g, "$1");
  return redactSensitiveRequestPath(withoutQuery);
}
