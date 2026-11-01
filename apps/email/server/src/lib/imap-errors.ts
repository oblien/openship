export type ImapFailure = "credentials" | "connection" | "tls" | "unavailable";

const CONNECTION_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "ENONET",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "NoConnection",
  "ClosedAfterConnectTLS",
  "ClosedAfterConnectText",
  "EConnectionClosed",
]);

/** ImapFlow also marks socket/server failures during AUTH as authenticationFailed. */
export function classifyImapFailure(error: unknown): ImapFailure {
  if (!error || typeof error !== "object") return "unavailable";
  const failure = error as Record<string, unknown>;
  const code = typeof failure.code === "string" ? failure.code : "";
  if (
    failure.tlsFailed === true ||
    /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT)/.test(
      code,
    )
  ) {
    return "tls";
  }
  if (CONNECTION_CODES.has(code) || failure.name === "ImapTimeoutError") return "connection";

  if (failure.authenticationFailed === true && failure.responseStatus === "NO") {
    if (failure.serverResponseCode === "AUTHENTICATIONFAILED") return "credentials";
    // Older servers omit RFC 5530 response codes. Accept only an explicit
    // credential rejection; a bare NO can also mean an unavailable auth backend.
    if (
      !failure.serverResponseCode &&
      typeof failure.responseText === "string" &&
      /^(?:authentication failed|login failed|invalid credentials|invalid (?:email|username) or password)[.!]?$/i.test(
        failure.responseText.trim(),
      )
    ) {
      return "credentials";
    }
  }
  return "unavailable";
}
