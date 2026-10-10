/**
 * Bases a desktop may store as its cloud API.
 *
 * https is allowed for any host. http is allowed only for loopback, so a
 * pasted public http URL cannot become the bearer target. Userinfo, query,
 * and hash are rejected. The stored value is the origin, or that origin plus
 * the self-hosted dashboard proxy prefix `/api/proxy`. Any other path is
 * rejected. Callers append `/api/...` after this base.
 */
const SELF_HOST_API_PREFIX = "/api/proxy";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function parseAllowedCloudOrigin(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;
  if (url.protocol === "https:") {
    // Any https host. The bearer is only sent back to this host.
  } else if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!LOOPBACK_HOSTS.has(host)) return null;
  } else {
    return null;
  }
  if (url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return url.origin;
  if (path === SELF_HOST_API_PREFIX) return `${url.origin}${SELF_HOST_API_PREFIX}`;
  return null;
}
