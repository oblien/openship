/**
 * Strip URL credentials, bare GitHub tokens and credential-bearing Git commands
 * out of text that is about to be logged or persisted.
 *
 * The deploy path injects a git credential into a clone URL's userinfo
 * (`https://x-access-token:<token>@github.com/...`). Git echoes that URL back in
 * some failures (notably submodule clones: `clone of '<url>' into submodule path
 * ... failed`), and the error text then travels into `deployment.error_message`,
 * notifications and server logs. This is the one shared implementation so the
 * db layer, the adapters and the platform redact the same shapes.
 *
 * URL quantifiers are bounded: an unbounded scheme or userinfo class
 * backtracks quadratically on long build-output lines (see build-log-sanitize).
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@'"]{1,2048}@/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
// Executors may quote an entire shell command on failure. Omit its credential
// assignments and remaining command text, including nested quoting/newlines;
// legacy tokens do not have a recognizable GitHub prefix.
const GIT_CREDENTIAL_COMMAND = /\bOPENSHIP_GIT_(?:USERNAME|PASSWORD)=[\s\S]*/;

export const REDACTED_CREDENTIAL = "***";

export function redactUrlCredentials(text: string): string;
export function redactUrlCredentials(text: string | null | undefined): string | null | undefined;
export function redactUrlCredentials(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text
    .replace(GIT_CREDENTIAL_COMMAND, "[REDACTED GIT COMMAND]")
    .replace(URL_USERINFO, `$1${REDACTED_CREDENTIAL}@`)
    .replace(GITHUB_TOKEN, REDACTED_CREDENTIAL);
}
