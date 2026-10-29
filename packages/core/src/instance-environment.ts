/** Portable integration configuration, never process authority, database
 * addresses, host paths, Cloud reseller credentials, or encryption keys. */
export const INSTANCE_ENVIRONMENT_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_SECURE",
  "GITHUB_AUTH_MODE",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY_BASE64",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_STATE_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_DISPLAY_NAME",
] as const;

export function instanceEnvironment(values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of INSTANCE_ENVIRONMENT_KEYS) {
    const value = values[key];
    if (typeof value === "string" && value) result[key] = value;
  }
  return result;
}
