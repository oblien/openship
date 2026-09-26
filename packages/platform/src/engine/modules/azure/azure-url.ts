/**
 * Pure Azure DevOps URL/header helpers — no env, DB or network imports so the
 * security-relevant seams stay trivially testable.
 */

/** Basic auth header for an Azure PAT (any non-empty username, PAT as password). */
export function authHeader(token: string): string {
  return `Basic ${Buffer.from(`pat:${token}`).toString("base64")}`;
}

/**
 * Azure DevOps organization slug from a REST URL — the credential to use is
 * derived from the request target, never from client-supplied fields.
 */
export function adoOrgFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // REST API URLs live on exactly dev.azure.com. Subdomains like
    // ssh.dev.azure.com are not REST hosts — the first path segment there is
    // "v3", not an organization, so matching the suffix would misderive it.
    if (host === "dev.azure.com") {
      return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    }
    const vs = host.match(/^([^.]+)\.visualstudio\.com$/);
    return vs?.[1] ?? null;
  } catch {
    return null;
  }
}
