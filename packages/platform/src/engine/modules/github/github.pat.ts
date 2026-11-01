/** Shared PAT inspection for personal and instance credentials. No auth or database setup. */
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { ghSend } from "./github.http";

/**
 * OAuth scopes that strictly exceed Openship's needs and should warn a
 * user when present on a saved PAT. These are the broad, account- or
 * org-administrative scopes; possessing them does not break Openship,
 * but the dashboard's PAT save handler should surface a clear warning
 * so the user understands they handed us more access than necessary.
 *
 * Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */
export const PAT_SCOPE_WARN_PATTERNS: readonly RegExp[] = [
  /^admin:/i, // admin:org, admin:repo_hook, admin:public_key, …
  /^delete_repo$/i,
  /^write:packages$/i,
  /^write:org$/i,
];

/**
 * Scopes that are REQUIRED — at least one of these MUST be present on a
 * saved PAT. `repo` grants full private-repo read/write; `public_repo`
 * is the public-only subset. Without either we cannot clone or list any
 * non-public repo, so the dashboard's PAT save handler should hard-fail.
 */
export const PAT_SCOPE_REQUIRED: readonly string[] = ["repo", "public_repo"];

/**
 * Result of `inspectPatScope`.
 *
 *   - `scopes` is the validated list of OAuth scopes returned by GitHub
 *     (from the `x-oauth-scopes` response header). Empty when the token
 *     is a fine-grained PAT that doesn't expose classic scopes.
 *   - `user` is the GitHub login the token belongs to — useful for
 *     attribution and downstream "this PAT belongs to @x" UX.
 */
export interface PatScopeReport {
  scopes: string[];
  user: string;
}

/**
 * HIGH #10 — inspect a PAT before we accept and store it. Calls
 * `GET /user` with the proposed token and reads `x-oauth-scopes` from
 * the response header (the canonical place GitHub publishes the scope
 * set of a classic OAuth/PAT token; absent or empty for fine-grained
 * PATs, where scope is set via the repo permission model instead).
 *
 * Throws on any non-2xx — callers should map that to a clean "invalid
 * token" response. The returned `scopes` array is whitespace-split and
 * lowercased; the controller decides whether to:
 *   - REJECT outright (missing every PAT_SCOPE_REQUIRED entry),
 *   - WARN (any PAT_SCOPE_WARN_PATTERNS match), or
 *   - persist alongside `user_settings.patScope` for later re-validation.
 */
export async function inspectPatScope(token: string): Promise<PatScopeReport> {
  const res = await ghSend(token, { url: "https://api.github.com/user" });
  if (!res.ok) {
    const body = await res.text().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/github/github.pat"); return ""; });
    throw new Error(
      `Could not validate PAT (GitHub returned ${res.status}). ${body.slice(0, 200)}`,
    );
  }
  const scopeHeader = res.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopeHeader
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const json = (await res.json()) as { login?: string };
  return { scopes, user: json.login ?? "" };
}

/**
 * Convenience classifier for the inspectPatScope report. Centralizes
 * the policy so callers don't reimplement the rules independently.
 *
 * Returns:
 *   - `{ ok: false, reason }`  — token lacks every required scope; the
 *     caller MUST refuse to save it.
 *   - `{ ok: true, warning }`  — token includes a broader-than-needed
 *     scope; the caller SHOULD surface this back in the response body.
 *   - `{ ok: true }`           — token is fine.
 */
export function classifyPatScope(
  report: PatScopeReport,
): { ok: false; reason: string } | { ok: true; warning?: string } {
  const scopeSet = new Set(report.scopes);

  // Fine-grained PATs report no classic scopes — pass without warning.
  // The GitHub API still gates each request by the repo permission grid,
  // so the token can't escalate beyond what the user explicitly granted.
  if (report.scopes.length === 0) return { ok: true };

  if (!PAT_SCOPE_REQUIRED.some((s) => scopeSet.has(s))) {
    return {
      ok: false,
      reason: `PAT is missing required scope (need one of: ${PAT_SCOPE_REQUIRED.join(", ")}). Got: ${report.scopes.join(", ") || "none"}.`,
    };
  }

  const broad = report.scopes.filter((s) => PAT_SCOPE_WARN_PATTERNS.some((re) => re.test(s)));
  if (broad.length > 0) {
    return {
      ok: true,
      warning: `PAT has broader scope than needed: ${broad.join(", ")}. Consider regenerating with only \`repo\` (or \`public_repo\`).`,
    };
  }
  return { ok: true };
}
