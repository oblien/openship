/** Shared release/advisory cadence. Signing in to Openship is not GitHub authentication. */
export const UPDATE_POLL_AUTHENTICATED_MS = 5 * 60_000;
export const UPDATE_POLL_ANONYMOUS_MS = 60 * 60_000;
export function updatePollInterval(authenticated: boolean): number {
  return authenticated ? UPDATE_POLL_AUTHENTICATED_MS : UPDATE_POLL_ANONYMOUS_MS;
}

/** Never let a manual refresh bypass GitHub's server-directed backoff. */
export function updateRetryAt(headers: Headers, now: number, failures: number): number {
  const retry = headers.get("retry-after");
  const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
  const retryAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry ?? "");
  const reset = Number(headers.get("x-ratelimit-reset"));
  const rateReset = headers.get("x-ratelimit-remaining") === "0" && reset > 0 ? reset * 1000 : 0;
  return Math.max(
    now + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(failures, 9)),
    Number.isFinite(retryAt) ? retryAt : 0,
    rateReset,
  );
}
