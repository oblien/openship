import { getCloudApiOrigin, getCloudDashboardUrl } from "@/lib/api/urls";

export const DESKTOP_CLOUD_FLOW = "desktop-cloud";
const DEFAULT_APP_NAME = "Openship Desktop";
const DEFAULT_POLL_INTERVAL_MS = 2000;

type SearchParamsLike = {
  get(name: string): string | null;
};

type DesktopCloudAuthFailure = "start_failed" | "expired" | "error" | "cancelled";

export function buildDesktopAuthorizeUrl(options: {
  cloudAuthUrl?: string;
  callbackUrl: string;
  appName?: string;
  machine?: string | null;
  state?: string | null;
  codeChallenge?: string | null;
}) {
  const baseUrl = getCloudDashboardUrl(options.cloudAuthUrl);
  const params = new URLSearchParams({
    callback: options.callbackUrl,
    app: options.appName || DEFAULT_APP_NAME,
    flow: DESKTOP_CLOUD_FLOW,
  });

  if (options.machine) params.set("machine", options.machine);
  if (options.state) params.set("state", options.state);
  if (options.codeChallenge) params.set("code_challenge", options.codeChallenge);

  return `${baseUrl}/authorize?${params.toString()}`;
}

export function getCloudConnectHandoffUrl(
  callbackUrl: string,
  // cloudApiUrl: the API-provided cloud origin (respects OPENSHIP_CLOUD_TARGET).
  // Pass it so self-hosted → cloud connect hits the configured cloud, not the
  // static table default (api.openship.io).
  options?: { state?: string | null; codeChallenge?: string | null; cloudApiUrl?: string },
) {
  const params = new URLSearchParams({ redirect: callbackUrl });
  if (options?.state) params.set("state", options.state);
  if (options?.codeChallenge) params.set("code_challenge", options.codeChallenge);
  return `${getCloudApiOrigin(options?.cloudApiUrl)}/api/cloud/connect-handoff?${params.toString()}`;
}

/* ── PKCE helpers (browser-only) ─────────────────────────────────── */

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 code_verifier — 32 random bytes, base64url-encoded. */
export function generatePkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** RFC 7636 S256 code_challenge: base64url(SHA-256(verifier)). */
export async function computePkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Random flow id, used as the storage key for the verifier and the
 *  `state` param on the handoff URL. */
export function generateConnectFlowId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Storage key for the in-flight verifier. localStorage (not sessionStorage)
 *  because the popup runs in a different tab/window and sessionStorage is
 *  per-tab — localStorage is shared across same-origin windows. */
export const CONNECT_PKCE_STORAGE_PREFIX = "openship.cloud-connect.pkce.";

/**
 * Generate a fresh PKCE pair, stash the verifier under a random flow id
 * in localStorage, and return {state, codeChallenge} ready to put on a
 * handoff URL. The callback page reads the verifier back keyed by state.
 *
 * Browser-only: requires `window.localStorage` + `crypto.subtle`. If
 * localStorage is unavailable (private mode, disabled) we still return
 * the pair so the URL gets bound to a challenge — but the round trip
 * will fail at the callback because the verifier is gone. Callers that
 * need a server-side path must wire their own storage.
 */
export async function preparePkceFlow(): Promise<{ state: string; codeChallenge: string }> {
  const flowId = generateConnectFlowId();
  const verifier = generatePkceVerifier();
  const codeChallenge = await computePkceChallenge(verifier);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONNECT_PKCE_STORAGE_PREFIX + flowId, verifier);
    } catch {
      /* localStorage disabled — callback round trip will fail, but at
       * least the URL is PKCE-bound so a bearer code can't be replayed. */
    }
  }
  return { state: flowId, codeChallenge };
}

export function getCloudDesktopHandoffUrl(options: {
  callbackUrl: string;
  state?: string | null;
  codeChallenge?: string | null;
  cloudApiUrl?: string;
}) {
  const params = new URLSearchParams({
    redirect: options.callbackUrl,
    ...(options.state ? { state: options.state } : {}),
    ...(options.codeChallenge ? { code_challenge: options.codeChallenge } : {}),
  });

  return `${getCloudApiOrigin(options.cloudApiUrl)}/api/cloud/desktop-handoff?${params.toString()}`;
}

export function buildAuthPageHref(route: "/login" | "/register" | "/authorize", searchParams: SearchParamsLike) {
  const params = new URLSearchParams();

  for (const key of ["callback", "app", "machine", "state", "code_challenge", "flow"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  // Preserve `returnTo` through the login ↔ register link bounce. The
  // allowlist-based `validateReturnTo` re-checks the value at the next
  // consumer, so a hostile value carried through here is still rejected
  // before any redirect happens.
  const returnTo = validateReturnTo(searchParams.get("returnTo"));
  if (returnTo) params.set("returnTo", returnTo);

  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

export function getPostAuthRedirect(searchParams: SearchParamsLike) {
  // `returnTo` is the post-auth target used by the consent-flow chain
  // (e.g. /cloud-authorize → /login?returnTo=… → back to /cloud-authorize).
  // Take precedence over the older `callback` flow when both are present.
  const returnTo = validateReturnTo(searchParams.get("returnTo"));
  if (returnTo) return returnTo;

  const callback = searchParams.get("callback");
  if (!callback) return null;

  if (searchParams.get("flow") === DESKTOP_CLOUD_FLOW) {
    return buildAuthPageHref("/authorize", searchParams);
  }

  return getCloudConnectHandoffUrl(callback);
}

/**
 * Allowlist for `?returnTo=` post-auth redirects.
 *
 * Open redirects via `returnTo` are the classic phishing vector — an
 * attacker sends a link like `/login?returnTo=https://evil.example/`
 * and the user lands on the attacker's site after entering creds.
 *
 * Rules:
 *   - Must be a relative path starting with a single `/`.
 *   - Must NOT start with `//` (protocol-relative URLs).
 *   - Path must match an allowlisted prefix. Currently only
 *     `/cloud-authorize`, `/mcp/authorize`, and `/` (root) are accepted;
 *     widen this list intentionally as new pages need it.
 *
 * Returns the validated path, or `null` when the input is unsafe or
 * missing. Callers should treat `null` as "no returnTo" and fall back
 * to whatever default they had before.
 */
export function validateReturnTo(input: string | null): string | null {
  if (!input) return null;
  if (typeof input !== "string") return null;
  if (input.length > 512) return null;
  // Must start with exactly one slash — `//evil.example` is a
  // protocol-relative URL that browsers resolve cross-origin.
  if (!input.startsWith("/")) return null;
  if (input.startsWith("//")) return null;
  // Reject control chars / whitespace anywhere — these can be used to
  // smuggle a CR/LF response-split or a hidden absolute URL past a naive
  // prefix check.
  if (/[\x00-\x1f\s]/.test(input)) return null;

  // Split off any query/fragment for the prefix check, but keep them on
  // the returned value so the consent page reloads with its params.
  const pathOnly = input.split(/[?#]/)[0];
  const ALLOWED_PREFIXES = ["/cloud-authorize", "/mcp/authorize", "/"];
  const isAllowed = ALLOWED_PREFIXES.some((prefix) => {
    if (prefix === "/") return pathOnly === "/";
    return pathOnly === prefix || pathOnly.startsWith(prefix + "/");
  });
  if (!isAllowed) return null;
  return input;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDesktopCloudAuth(options: {
  desktop: DesktopBridge;
  isCancelled?: () => boolean;
  pollIntervalMs?: number;
}) {
  const result = await options.desktop.onboarding.cloudAuth();
  if (!result?.ok || !result.nonce) {
    return { ok: false as const, reason: "start_failed" as DesktopCloudAuthFailure };
  }

  const isCancelled = options.isCancelled ?? (() => false);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (!isCancelled()) {
    await sleep(pollIntervalMs);
    const poll = await options.desktop.onboarding.cloudAuthPoll(result.nonce);

    if (poll.status === "resolved") {
      return { ok: true as const };
    }

    if (poll.status === "expired" || poll.status === "error") {
      return { ok: false as const, reason: poll.status };
    }
  }

  return { ok: false as const, reason: "cancelled" as DesktopCloudAuthFailure };
}
