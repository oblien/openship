/**
 * Resolve the dashboard listen address for Next.js `HOSTNAME`.
 *
 * Homelab reverse proxies need an explicit bind when there is no public URL —
 * default remains loopback; `--public-url` without managed edge still defaults
 * to all interfaces unless `--host` overrides.
 */
export function resolveDashboardHost(opts: {
  host?: string;
  publicUrl?: string;
  managedEdge?: boolean;
}): string {
  const explicit = opts.host?.trim();
  if (explicit) return explicit;
  // Reachable remotely when public; loopback-only otherwise. Under managed
  // edge the local OpenResty fronts the dashboard, so it stays on loopback
  // even though there's a public URL.
  return opts.publicUrl && !opts.managedEdge ? "0.0.0.0" : "127.0.0.1";
}
