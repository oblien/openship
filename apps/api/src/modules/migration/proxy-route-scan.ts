/**
 * Detect routes the server's EXISTING (foreign) reverse proxy already serves, so
 * the migrate wizard can surface each container's current domain(s) + SSL and
 * offer to keep them. Reuses the proxy-import machinery
 * (`probeEdge`/`importSites` → nginx/caddy/apache/traefik vhost parsers) — no new
 * config parser. Read-only over SSH; never throws (a scan failure must not fail
 * discovery). The join key is the published host port the proxy forwards to.
 */

import { probeEdge, importSites, scanOpenshipEdge } from "@repo/adapters";
import type { CommandExecutor, ImportedSite } from "@repo/adapters";
import { sshManager } from "../../lib/ssh-manager";

export interface ExistingRouteSsl {
  /** The proxy terminates TLS for this route (listen 443 / ssl). */
  enabled: boolean;
  /** Foreign cert paths parsed from the vhost (reuse candidate; view-only hint). */
  certPath?: string;
  keyPath?: string;
}

export interface ExistingRoute {
  /** Published host port the proxy forwards to — the container-join key. */
  port: number;
  /** Location path prefix this upstream serves (e.g. "/", "/v3"). */
  path: string;
  domains: string[];
  ssl: ExistingRouteSsl;
  /** Config file the vhost came from (traceability). */
  source?: string;
}

/**
 * PURE. Reverse-index parsed proxy sites by their upstream (published host) port.
 * A vhost's `routes` (per-location upstreams) are indexed individually, so a
 * path-fan-out domain (`/ → :1010`, `/v3 → :1020`) yields one entry PER port,
 * each carrying its path — letting the join attach `/v3` to the `:1020` service.
 * Each port maps to a LIST (a port can serve multiple paths / come from multiple
 * vhosts). Static docroots (no upstream port) are skipped. Same (port,path) from
 * multiple vhosts union their domains and prefer an SSL-terminating one's cert.
 */
export function buildProxyRouteIndex(sites: ImportedSite[]): Map<number, ExistingRoute[]> {
  const byPort = new Map<number, ExistingRoute[]>();
  for (const site of sites) {
    // Prefer the full per-location set; fall back to the primary proxy target.
    const upstreams =
      site.routes ??
      (site.target.kind === "proxy" ? [{ path: "/", url: site.target.url }] : []);

    for (const up of upstreams) {
      let port: number;
      try {
        port = Number(new URL(up.url).port);
      } catch {
        continue;
      }
      if (!Number.isFinite(port) || port <= 0) continue;

      const list = byPort.get(port) ?? [];
      const existing = list.find((r) => r.path === up.path);
      if (existing) {
        existing.domains = [...new Set([...existing.domains, ...site.serverNames])];
        if (site.ssl) {
          existing.ssl.enabled = true;
          if (!existing.ssl.certPath && site.tls) {
            existing.ssl.certPath = site.tls.certPath;
            existing.ssl.keyPath = site.tls.keyPath;
          }
        }
      } else {
        list.push({
          port,
          path: up.path,
          domains: [...site.serverNames],
          ssl: site.ssl
            ? { enabled: true, certPath: site.tls?.certPath, keyPath: site.tls?.keyPath }
            : { enabled: false },
          source: site.source,
        });
      }
      byPort.set(port, list);
    }
  }
  return byPort;
}

/**
 * IO. One read-only SSH pass: detect the edge proxy and index the routes it
 * already serves by upstream port. Handles BOTH a recognized FOREIGN proxy
 * ("known" → `importSites` parses its vhosts) AND our OWN OpenResty edge
 * ("ours" → `scanOpenshipEdge` reads the sites tree NginxProvider wrote — so
 * containers previously deployed through Openship surface their existing
 * domain + SSL too). "free"/"unknown" → nothing to carry. Any failure → empty
 * map (a scan failure must never fail discovery).
 */
export async function scanProxyRoutes(serverId: string): Promise<Map<number, ExistingRoute[]>> {
  try {
    return await sshManager.withExecutor(serverId, scanProxyRoutesWithExecutor);
  } catch {
    return new Map<number, ExistingRoute[]>();
  }
}

/**
 * Executor-scoped core of {@link scanProxyRoutes}. Split out so callers that
 * already hold the right host executor — e.g. cert reuse on the auto-registered
 * LOCAL host-server, where `sshManager` (SSH-only) can't connect — can scan the
 * edge on `createHostExecutor()` instead. Never throws; empty map on any failure.
 */
export async function scanProxyRoutesWithExecutor(
  exec: CommandExecutor,
): Promise<Map<number, ExistingRoute[]>> {
  try {
    const edge = await probeEdge(exec);
    let sites: ImportedSite[];
    if (edge.classification === "known") {
      sites = (await importSites(exec, edge)).sites; // never throws; empty for unimportable
    } else if (edge.classification === "ours") {
      sites = (await scanOpenshipEdge(exec)).sites; // our OpenResty server blocks
    } else {
      return new Map<number, ExistingRoute[]>();
    }
    return buildProxyRouteIndex(sites);
  } catch {
    return new Map<number, ExistingRoute[]>();
  }
}
