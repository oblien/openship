/**
 * Cross-window channel for surfacing a GitHub "Connect" link failure.
 *
 * The connect popup lands on an /auth/callback page after Better Auth's OAuth
 * callback. On failure Better Auth appends `?error=<code>`; the callback page
 * stashes that code here (same-origin localStorage) and closes. The opener's
 * post-close handler reads + clears it and shows a toast — otherwise the flow
 * would just silently report "not connected".
 */
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
export const GITHUB_CONNECT_ERROR_KEY = "openship.github.connectError";

type ConnectErrorStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): ConnectErrorStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/lib/github-connect-error");
    return null;
  }
}

/** Store a callback error for the window that initiated the OAuth flow. */
export function storeGitHubConnectError(
  error: string,
  storage: ConnectErrorStorage | null = browserStorage(),
  state?: string,
): void {
  if (!error || !storage) return;
  try {
    storage.setItem(state ? `${GITHUB_CONNECT_ERROR_KEY}.${state}` : GITHUB_CONNECT_ERROR_KEY, error);
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/lib/github-connect-error");
    /* storage unavailable */
  }
}

/** Read and clear the callback error so it cannot leak into a later attempt. */
export function consumeGitHubConnectError(
  storage: ConnectErrorStorage | null = browserStorage(),
  state?: string,
): string | null {
  if (!storage) return null;
  try {
    const key = state ? `${GITHUB_CONNECT_ERROR_KEY}.${state}` : GITHUB_CONNECT_ERROR_KEY;
    const error = storage.getItem(key);
    if (error !== null) storage.removeItem(key);
    return error;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/lib/github-connect-error");
    return null;
  }
}

const MESSAGES: Record<string, string> = {
  account_already_linked_to_different_user:
    "That GitHub account is already linked to a different Openship user. Sign in as that user, or disconnect GitHub there first.",
  "email_doesn't_match":
    "Your GitHub email doesn't match this account's email. Connect a GitHub account that uses the same email.",
  email_not_found:
    "GitHub didn't share a usable email. Make your GitHub email public (or verify one) and try again.",
  unable_to_link_account: "Couldn't link your GitHub account. Please try again.",
};

export function githubConnectErrorMessage(code: string | null | undefined): string {
  const value = code?.trim();
  if (!value) return "Couldn't connect GitHub. Please try again.";
  if (MESSAGES[value]) return MESSAGES[value];

  // OAuth failures arrive as machine codes, while later installation-claim
  // failures are already useful server messages stored through the same
  // cross-window channel. Preserve those messages instead of wrapping them as
  // if the entire sentence were an unknown error code.
  return /^[a-z\d._-]+$/i.test(value) ? `Couldn't connect GitHub (${value}).` : value;
}
