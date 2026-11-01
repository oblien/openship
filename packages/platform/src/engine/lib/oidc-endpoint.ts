/** Require HTTPS; allow HTTP only for a loopback IdP during development/tests. */
export function oidcEndpointAllowed(url: URL, nodeEnv: string): boolean {
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return (
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}
