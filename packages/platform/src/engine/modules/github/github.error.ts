const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True when a failed GitHub call says nothing about the credential itself: a
 * server error, a rate limit, a timeout or a broken connection. Such failures
 * must be retried by the caller instead of being read as "no credential".
 */
export function isTransientGitHubFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 4; depth++) {
    const value = cause as {
      status?: number;
      statusCode?: number;
      code?: string;
      name?: string;
      credentialRejected?: boolean;
      cause?: unknown;
    };
    const status = Number(value.status ?? value.statusCode);
    if (
      status === 408 ||
      status === 429 ||
      (status >= 500 && status < 600) ||
      (status === 403 && value.credentialRejected === false) ||
      value.name === "AbortError" ||
      value.name === "TimeoutError" ||
      TRANSIENT_NETWORK_CODES.has(value.code ?? "")
    )
      return true;
    cause = value.cause;
  }
  return false;
}

/** Shared classification without loading credentials, storage or configuration. */
export function isGitHubCredentialRejected(
  status: number,
  headers: Headers,
  message?: unknown,
): boolean {
  return (
    status === 401 ||
    (status === 403 &&
      headers.get("x-ratelimit-remaining") !== "0" &&
      !headers.has("retry-after") &&
      !(typeof message === "string" && /rate limit|abuse detection/i.test(message)))
  );
}

/** Machine-readable failure details; never retry a mutation after an auth error. */
export class GitHubApiError extends Error {
  readonly credentialRejected: boolean;

  constructor(
    readonly status: number,
    message: string,
    headers: Headers,
  ) {
    super(`GitHub API error (${status}): ${message}`);
    this.name = "GitHubApiError";
    this.credentialRejected = isGitHubCredentialRejected(status, headers, message);
  }
}
