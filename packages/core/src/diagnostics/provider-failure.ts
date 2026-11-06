import { diagnosticProperty } from "./redaction";

// Only published transport/system identifiers may become public text. A valid
// looking arbitrary SDK code can itself be a credential or a request value.
const PUBLIC_CODES = new Set([
  "ABORT_ERR", "EACCES", "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED",
  "ECONNRESET", "EDQUOT", "EHOSTUNREACH", "EIO", "EMFILE", "ENETUNREACH",
  "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "ENOTFOUND", "EPERM", "EPIPE",
  "EROFS", "ESOCKETTIMEDOUT", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);

/** The summary belongs to the caller. Provider text, names, payloads and stacks
 * are never used. Read a bounded cause chain through data properties only. */
export function providerFailureMessage(error: unknown, summary: string): string {
  let code: string | undefined;
  let status: number | undefined;
  let current = error;
  for (let depth = 0; current && depth < 3; depth++) {
    const candidate = diagnosticProperty(current, "code");
    if (!code && typeof candidate === "string" && PUBLIC_CODES.has(candidate)) code = candidate;
    for (const value of [
      diagnosticProperty(current, "statusCode"),
      diagnosticProperty(current, "status"),
      diagnosticProperty(diagnosticProperty(current, "$metadata"), "httpStatusCode"),
    ]) {
      if (status === undefined && typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)
        status = value;
    }
    current = diagnosticProperty(current, "cause");
  }
  const details = [code, status === undefined ? undefined : `HTTP ${status}`].filter(Boolean);
  return details.length ? `${summary} (${details.join(", ")})` : summary;
}
