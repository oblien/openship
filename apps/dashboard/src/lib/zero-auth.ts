import { LOOPBACK_HOSTNAMES } from "@repo/core";

/**
 * What the login page should do when the instance reports `authMode: "none"`.
 *
 * Zero-auth has no sign-in form: the page's whole job is to bounce the browser
 * to `/api/auth/desktop-login`, which mints a session cookie and redirects back.
 * The server only grants that session to a browser on the same machine
 * (zeroAuthAllowed), so bouncing a REMOTE browser is guaranteed to fail — and
 * because the redirect leaves the page, the operator sees a spinner and then
 * either a connection error on a host that isn't theirs or an endless bounce,
 * with nothing on screen naming the cause.
 *
 * So the decision is made before navigating, and "we can't sign you in here" is
 * a state the page can render.
 */
export type ZeroAuthDecision =
  | { action: "wait" }
  | { action: "redirect"; url: string }
  | { action: "explain"; reason: "remote_browser" | "refused" };

/** A bounce back to /login this recent is the server refusing, not a session that aged out. */
const BOUNCE_WINDOW_MS = 15_000;

const ATTEMPT_KEY = "openship.zeroAuthAttemptedAt";

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function resolveZeroAuthLogin(input: {
  /** `window.location.origin`, or undefined during SSR. */
  pageOrigin: string | undefined;
  /** The API base the rest of the client talks to — honours proxy mode and the desktop's dynamic port. */
  apiBaseUrl: string;
  attemptedAt: number | undefined;
  now: number;
}): ZeroAuthDecision {
  const { pageOrigin, apiBaseUrl, attemptedAt, now } = input;
  if (!pageOrigin) return { action: "wait" };
  if (!isLoopbackOrigin(pageOrigin)) return { action: "explain", reason: "remote_browser" };
  // We already bounced and we're back on /login: desktop-login refused, and
  // going again would just loop.
  if (attemptedAt !== undefined && now - attemptedAt >= 0 && now - attemptedAt < BOUNCE_WINDOW_MS) {
    return { action: "explain", reason: "refused" };
  }
  return { action: "redirect", url: `${apiBaseUrl.replace(/\/+$/, "")}/auth/desktop-login` };
}

/* sessionStorage is per-tab and unavailable in some privacy modes — a throw here
   must not take the login page down with it, so every access is optional. */

export function readZeroAuthAttempt(): number | undefined {
  try {
    const raw = window.sessionStorage.getItem(ATTEMPT_KEY);
    if (!raw) return undefined;
    const at = Number(raw);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

export function markZeroAuthAttempt(now: number): void {
  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, String(now));
  } catch {
    /* best-effort: without the mark we can still loop, which is the old behaviour */
  }
}

export function clearZeroAuthAttempt(): void {
  try {
    window.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* nothing to clear */
  }
}
