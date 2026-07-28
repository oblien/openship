/**
 * Proxy config import — read an existing reverse proxy's configuration and
 * normalize its sites so a migrate/takeover can re-register them as Openship
 * routes. All parsing is read-only and best-effort (warnings, never throws).
 */

import type { CommandExecutor } from "../../../types";
import type { ProxyKind, ProxyScanResult } from "../../types";
import { scanNginx, scanOpenshipEdge } from "./nginx";
import { scanCaddy } from "./caddy";
import { scanApache } from "./apache";
import { scanTraefik } from "./traefik";

/**
 * Config markers that prove a proxy is INSTALLED on this host, checked in
 * priority order. Deliberately NOT `/usr/local/openresty/...` — that's ours.
 */
const INSTALLED_MARKERS: Array<{ proxy: ProxyKind; paths: string[] }> = [
  { proxy: "nginx", paths: ["/etc/nginx/nginx.conf"] },
  { proxy: "caddy", paths: ["/etc/caddy/Caddyfile"] },
  { proxy: "apache", paths: ["/etc/apache2/apache2.conf", "/etc/httpd/conf/httpd.conf"] },
];

/**
 * Find a proxy that is installed on this host but is NOT currently serving
 * :80/:443 — i.e. one we already stopped.
 *
 * Why this exists: `probeEdge` can only see a proxy that HOLDS the ports, so once
 * a takeover stops the operator's nginx, its sites become invisible to the
 * migrate flow — even though every vhost is still sitting in /etc/nginx. A run
 * that stopped the proxy but failed to register its sites (or a re-run after
 * that) had no way to recover them, which is exactly how a box ends up serving
 * nothing for domains the operator was told would be migrated. The parsers read
 * config off disk and never touch the process, so a stopped proxy scans fine.
 *
 * Returns null when nothing importable is installed.
 */
export async function detectInstalledProxy(
  executor: CommandExecutor,
): Promise<ProxyKind | null> {
  const probe = INSTALLED_MARKERS.map(({ proxy, paths }) => {
    const test = paths.map((p) => `[ -f '${p}' ]`).join(" || ");
    return `{ ${test}; } && echo ${proxy}`;
  }).join("; ");
  let out = "";
  try {
    out = await executor.exec(`{ ${probe}; } 2>/dev/null; true`, { timeout: 10_000 });
  } catch {
    return null;
  }
  const found = new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return INSTALLED_MARKERS.find((m) => found.has(m.proxy))?.proxy ?? null;
}

/**
 * Scan a specific proxy's config into normalized sites. Returns an empty result
 * (with a warning) for proxies we can't import (e.g. haproxy — takeover-only).
 * traefik IS importable (via container labels) — see `scanTraefik`.
 */
export async function scanImportableSites(
  executor: CommandExecutor,
  proxy: ProxyKind,
): Promise<ProxyScanResult> {
  switch (proxy) {
    case "nginx":
      return scanNginx(executor);
    case "caddy":
      return scanCaddy(executor);
    case "apache":
      return scanApache(executor);
    case "traefik":
      return scanTraefik(executor);
    default:
      return {
        proxy,
        sites: [],
        warnings: [`${proxy}: config import not supported — takeover only`],
      };
  }
}

/** Which recognized proxies can we import config from? */
export function canImportProxy(proxy: ProxyKind | undefined): boolean {
  return proxy === "nginx" || proxy === "caddy" || proxy === "apache" || proxy === "traefik";
}

export { scanNginx, scanOpenshipEdge, scanCaddy, scanApache, scanTraefik };
