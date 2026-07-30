/**
 * Cross-window channel for surfacing a GitLab "Connect" link failure.
 *
 * The connect popup lands on the shared /auth/callback/close page after
 * Better Auth's OAuth callback. On failure Better Auth appends `?error=<code>`;
 * the callback page stashes that code here (same-origin localStorage) and
 * closes. The opener's post-close handler reads + clears it and shows a
 * toast — otherwise the flow would just silently report "not connected".
 *
 * Kept as a separate key (and message table) from GITHUB_CONNECT_ERROR_KEY
 * so a GitLab link failure never gets misread as a GitHub one when both
 * popups could plausibly be open.
 */
export const GITLAB_CONNECT_ERROR_KEY = "openship.gitlab.connectError";

/** Optional i18n overrides — keys match `settings.gitlab.connectErrors`. */
export type GitlabConnectErrorMessages = {
  default: string;
  unknown: string;
  account_already_linked_to_different_user: string;
  email_doesnt_match: string;
  email_not_found: string;
  unable_to_link_account: string;
};

const FALLBACK: GitlabConnectErrorMessages = {
  default: "Couldn't connect GitLab. Please try again.",
  unknown: "Couldn't connect GitLab ({code}).",
  account_already_linked_to_different_user:
    "That GitLab account is already linked to a different Openship user. Sign in as that user, or disconnect GitLab there first.",
  email_doesnt_match:
    "Your GitLab email doesn't match this account's email. Connect a GitLab account that uses the same email.",
  email_not_found:
    "GitLab didn't share a usable email. Make your GitLab email public (or verify one) and try again.",
  unable_to_link_account: "Couldn't link your GitLab account. Please try again.",
};

/** Better Auth uses `email_doesn't_match`; i18n keys can't embed `'`. */
const CODE_TO_KEY: Record<string, keyof GitlabConnectErrorMessages> = {
  account_already_linked_to_different_user: "account_already_linked_to_different_user",
  "email_doesn't_match": "email_doesnt_match",
  email_not_found: "email_not_found",
  unable_to_link_account: "unable_to_link_account",
};

export function gitlabConnectErrorMessage(
  code: string | null | undefined,
  messages: GitlabConnectErrorMessages = FALLBACK,
): string {
  if (!code) return messages.default;
  const key = CODE_TO_KEY[code];
  if (key && key !== "default" && key !== "unknown") {
    return messages[key];
  }
  return messages.unknown.replace("{code}", code);
}
