/**
 * Rewrite redirects that point back at the proxy's private upstream so the
 * client stays on the dashboard's reachable origin. Redirects to any other
 * origin (notably an OAuth client's loopback callback) pass through unchanged.
 */
export function rewriteUpstreamLocation(
  location: string,
  upstream: URL,
  publicOrigin: string,
): string {
  try {
    const redirect = new URL(location, upstream);
    if (redirect.origin !== upstream.origin) return location;

    const publicUrl = new URL(publicOrigin);
    redirect.protocol = publicUrl.protocol;
    redirect.hostname = publicUrl.hostname;
    redirect.port = publicUrl.port;
    return redirect.toString();
  } catch {
    return location;
  }
}
