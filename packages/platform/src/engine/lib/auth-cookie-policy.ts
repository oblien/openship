/**
 * Better Auth cannot infer the browser-facing scheme from the dynamic base URL
 * used by self-hosted instances. Pin the cookie policy only when the operator
 * declared a public URL:
 *
 * - HTTPS public instances must emit Secure cookies.
 * - Explicit HTTP instances keep working during local/LAN setup.
 * - An undeclared URL leaves Better Auth's cloud/development defaults intact.
 */
export function secureCookiePreference(publicUrl: string | undefined): boolean | undefined {
  const value = publicUrl?.trim();
  if (!value) return undefined;
  return new URL(value).protocol === "https:";
}
