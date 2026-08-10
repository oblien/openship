/**
 * The reverse-proxy READ api — one executor-bound object answering everything
 * callers need to know about whatever proxy is (or was) serving this box.
 *
 * The module already had a unified SCAN (`probeEdge` → `importSites` →
 * `ImportedSite`), but it was shaped for a single one-shot migration read, so
 * anything else got assembled at the call site. That's how the by-port index ended
 * up in the API's *migration* module — leaving a domains/SSL concern importing from
 * `../migration/` to answer an SSL question — and how five separate places grew
 * their own rules for reading a cert. This is the surface those callers should
 * reach for instead:
 *
 *   const proxy = await edgeProxy(exec)
 *   await proxy?.listSites()        // everything it serves, normalized
 *   await proxy?.sitesByPort()      // reverse-indexed by upstream host port
 *   await proxy?.siteFor(host)      // the one vhost answering for a hostname
 *   await proxy?.certFor(host)      // the cert it currently serves, validated
 *
 * One scan backs all four (memoized per instance), so asking three questions costs
 * one pass over the box.
 */

import type { ProxySettings } from "@repo/core";

import type { CommandExecutor, ManualCert } from "../../types";
import type { EdgeStatus, ImportedSite, ProxyKind, ProxyScanResult } from "../types";
import { probeEdge } from "./detect";
import { canImportProxy, detectInstalledProxy, scanImportableSites, scanOpenshipEdge } from "./import";
import { caddyStoreCert } from "./import/caddy-certs";
import { traefikAcmeCert, traefikDeclaredCertPaths } from "./import/traefik-certs";
import {
  readDeclaredPair,
  validateCertFor,
  type AdoptedCert,
  type CertCandidate,
} from "./cert-material";

export type { AdoptedCert, CertCandidate } from "./cert-material";

// ─── By-port index ────────────────────────────────────────────────────────────

export interface ProxySiteRouteSsl {
  /** The proxy terminates TLS for this route (listen 443 / ssl). */
  enabled: boolean;
  /** Cert paths the vhost DECLARED. Absent for auto-cert proxies (caddy/traefik)
   *  even when a cert exists — use `certFor(host)` to answer "is there a cert". */
  certPath?: string;
  keyPath?: string;
}

export interface ProxySiteRoute {
  /** Published host port the proxy forwards to — the container-join key. */
  port: number;
  /** Location path prefix this upstream serves (e.g. "/", "/v3"). */
  path: string;
  domains: string[];
  ssl: ProxySiteRouteSsl;
  /**
   * Adoptable reverse-proxy tunables the source vhost declared (`ImportedSite.proxy`).
   * Carried through the by-port index so a migrating project inherits the limits it
   * was already running under — adopting a site whose nginx allowed 200 MB uploads
   * and silently dropping it back to nginx's 1 MB default breaks the app on the
   * first upload after the cutover, with nothing in the UI to explain it.
   */
  proxy?: ProxySettings;
  /** Config file the vhost came from (traceability). */
  source?: string;
}

/**
 * PURE. Reverse-index parsed sites by their upstream (published host) port.
 * A vhost's `routes` (per-location upstreams) are indexed individually, so a
 * path-fan-out domain (`/ → :1010`, `/v3 → :1020`) yields one entry PER port,
 * each carrying its path — letting a join attach `/v3` to the `:1020` service.
 * Each port maps to a LIST (a port can serve multiple paths / come from multiple
 * vhosts). Static docroots (no upstream port) are skipped. Same (port,path) from
 * multiple vhosts union their domains and prefer an SSL-terminating one's cert.
 */
export function buildProxyRouteIndex(sites: ImportedSite[]): Map<number, ProxySiteRoute[]> {
  const byPort = new Map<number, ProxySiteRoute[]>();
  for (const site of sites) {
    // Prefer the full per-location set; fall back to the primary proxy target.
    const upstreams =
      site.routes ?? (site.target.kind === "proxy" ? [{ path: "/", url: site.target.url }] : []);

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
        // Same precedence as the cert above: the TLS vhost is the one really
        // serving the traffic, so its tunables win over the :80 helper's.
        if (site.proxy && (site.ssl || !existing.proxy)) existing.proxy = site.proxy;
      } else {
        list.push({
          port,
          path: up.path,
          domains: [...site.serverNames],
          ...(site.proxy ? { proxy: site.proxy } : {}),
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

// ─── Per-proxy cert sources ───────────────────────────────────────────────────

interface CertLookupCtx {
  exec: CommandExecutor;
  host: string;
  /** The vhost answering for `host`, when the scan found one. */
  site: ImportedSite | null;
  /** The proxy's own container, when it runs as one — certs may only exist inside. */
  container: string | null;
}

type RawCert = { certPem: string; keyPem: string; source: string };

/**
 * Cert paths the CONFIG declared. The nginx/apache/openresty answer in full, and
 * the first thing to try for caddy (an explicit `tls <cert> <key>` beats the
 * auto store, because it's what the operator chose to serve).
 */
async function declaredCert(ctx: CertLookupCtx): Promise<RawCert | null> {
  const tls = ctx.site?.tls;
  if (!tls) return null;
  const pems = await readDeclaredPair(ctx.exec, tls.certPath, tls.keyPath, ctx.container);
  return pems ? { ...pems, source: tls.certPath } : null;
}

/** Cert lookup per proxy kind, tried in order until one yields material. */
const CERT_SOURCES: Record<ProxyKind, Array<(ctx: CertLookupCtx) => Promise<RawCert | null>>> = {
  nginx: [declaredCert],
  openresty: [declaredCert],
  apache: [declaredCert],
  caddy: [declaredCert, (c) => caddyStoreCert(c.exec, c.host, c.container)],
  traefik: [
    (c) => traefikAcmeCert(c.exec, c.host, c.container),
    // File provider: paths aren't bound to a hostname (traefik picks by SNI), so
    // hand every declared pair to the validator and let coverage decide.
    async (c) => {
      for (const pair of await traefikDeclaredCertPaths(c.exec, c.container)) {
        const pems = await readDeclaredPair(c.exec, pair.certPath, pair.keyPath, c.container);
        if (!pems) continue;
        if (validateCertFor(c.host, pems, pair.certPath).cert) {
          return { ...pems, source: pair.certPath };
        }
      }
      return null;
    },
  ],
  // Takeover-only: no importable config, so no cert to find either.
  haproxy: [],
};

// ─── The api ──────────────────────────────────────────────────────────────────

export interface EdgeProxyApi {
  /** Which proxy this reads. */
  kind: ProxyKind;
  /** Is this OUR OpenResty edge (rather than a foreign proxy)? */
  ours: boolean;
  /** The proxy's container, when it runs as one. */
  container: string | null;
  /** Everything it serves, normalized. One scan, memoized. */
  listSites(): Promise<ProxyScanResult>;
  /** Sites reverse-indexed by the published host port they forward to. */
  sitesByPort(): Promise<Map<number, ProxySiteRoute[]>>;
  /** The vhost answering for `host`, or null. */
  siteFor(host: string): Promise<ImportedSite | null>;
  /** The validated cert it currently serves for `host`, or null. */
  certFor(host: string): Promise<AdoptedCert | null>;
  /**
   * `certFor` with the rejection reason kept. Use this wherever the operator
   * should learn WHY reuse was declined ("cert covers a.com — not b.com") instead
   * of silently getting an ACME issuance.
   */
  certCandidateFor(host: string): Promise<CertCandidate>;
}

/**
 * Bind the read api to whatever proxy is serving (or installed on) the box
 * `exec` reaches. Returns null when there's nothing to read.
 *
 * Resolution order:
 *   1. `status` (or a fresh `probeEdge`) — `ours` reads our OpenResty sites tree,
 *      `known` reads the foreign proxy's config.
 *   2. `detectInstalledProxy` — a proxy INSTALLED but not holding the ports, i.e.
 *      one a takeover already stopped. `probeEdge` can't see it, so without this
 *      step a re-run after a partial takeover finds nothing and every domain the
 *      operator was told would migrate silently becomes a fresh ACME issuance.
 *
 * Read-only throughout; every method fails soft (empty result / null).
 */
export async function edgeProxy(
  exec: CommandExecutor,
  opts: { status?: EdgeStatus } = {},
): Promise<EdgeProxyApi | null> {
  const status = opts.status ?? (await probeEdge(exec).catch(() => null));
  if (!status) return null;

  let kind: ProxyKind | null = null;
  let ours = false;
  if (status.classification === "ours") {
    kind = "openresty";
    ours = true;
  } else if (status.classification === "known") {
    const found = status.occupants.find((o) => o.proxy)?.proxy;
    kind = found && canImportProxy(found) ? found : null;
  }
  // Nothing on the ports (or something unrecognized) — but a stopped proxy's
  // config is still on disk and still migratable.
  if (!kind) kind = await detectInstalledProxy(exec).catch(() => null);
  if (!kind) return null;

  const container = status.occupants.find((o) => o.proxy === kind)?.containerName ?? null;
  return makeApi(exec, kind, ours, container);
}

/**
 * The api over a proxy the caller has ALREADY identified — skips the probe.
 * For callers holding an `EdgeStatus` mid-takeover, and for tests.
 */
export function edgeProxyFor(
  exec: CommandExecutor,
  kind: ProxyKind,
  opts: { ours?: boolean; container?: string | null } = {},
): EdgeProxyApi {
  // `ours` defaults FALSE: a bare kind shortcut is a FOREIGN proxy unless the
  // caller says otherwise. It used to default `kind === "openresty"` — the stale
  // bare-edge assumption ("an openresty IS our edge"), which is wrong now that our
  // edge is a container. That default made the one caller (harvesting certs from a
  // proxy we're migrating FROM) read a foreign OpenResty through `scanOpenshipEdge`
  // instead of `scanForeignOpenResty`, so a legacy bare edge's vhost-declared certs
  // at non-default paths were silently not harvested — the sites migrated with no TLS.
  return makeApi(exec, kind, opts.ours ?? false, opts.container ?? null);
}

/**
 * Harvest the certs a proxy currently serves for every hostname in `sites`,
 * keyed by hostname, ready to hand to `registerImportedSites`' `certPems`.
 *
 * Call this while the source proxy is still RUNNING. A takeover stops it before
 * re-registering anything, and a containerized caddy/traefik keeps its cert store
 * inside the container — once it's stopped, `docker exec` can't reach the store and
 * the cert is simply gone as far as we're concerned. Reading up front also means
 * the material is in hand before the box goes through its most fragile moment.
 */
export async function collectProxyCerts(
  api: EdgeProxyApi,
  sites: ImportedSite[],
): Promise<{ certPems: Record<string, ManualCert>; warnings: string[] }> {
  const certPems: Record<string, ManualCert> = {};
  const warnings: string[] = [];
  const hosts = [...new Set(sites.filter((s) => s.ssl).flatMap((s) => s.serverNames))];
  for (const host of hosts) {
    const candidate = await api.certCandidateFor(host).catch(() => null);
    if (candidate?.cert) {
      certPems[host] = { certPem: candidate.cert.certPem, keyPem: candidate.cert.keyPem };
    } else if (candidate?.reason) {
      warnings.push(`${host}: no reusable certificate — ${candidate.reason}`);
    }
  }
  return { certPems, warnings };
}

function makeApi(
  exec: CommandExecutor,
  kind: ProxyKind,
  ours: boolean,
  container: string | null,
): EdgeProxyApi {
  // One scan per instance backs sites / by-port / siteFor / certFor.
  let scan: Promise<ProxyScanResult> | null = null;
  const listSites = () => {
    scan ??= (ours ? scanOpenshipEdge(exec) : scanImportableSites(exec, kind)).catch(() => ({
      proxy: kind,
      sites: [],
      warnings: [`${kind}: config scan failed`],
    }));
    return scan;
  };

  const siteFor = async (host: string): Promise<ImportedSite | null> => {
    const target = host.toLowerCase();
    const { sites } = await listSites();
    return (
      sites.find((s) => s.serverNames.some((n) => n.toLowerCase() === target)) ??
      // A wildcard vhost (`*.example.com`) serves the host without naming it.
      sites.find((s) =>
        s.serverNames.some((n) => {
          const name = n.toLowerCase();
          if (!name.startsWith("*.")) return false;
          const suffix = name.slice(1);
          return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes(".");
        }),
      ) ??
      null
    );
  };

  const certCandidateFor = async (host: string): Promise<CertCandidate> => {
    const site = await siteFor(host);
    const ctx: CertLookupCtx = { exec, host, site, container };
    let lastReason: string | null = null;
    for (const source of CERT_SOURCES[kind] ?? []) {
      const raw = await source(ctx).catch(() => null);
      if (!raw) continue;
      const candidate = validateCertFor(host, raw, raw.source);
      if (candidate.cert) return candidate;
      lastReason = candidate.reason;
    }
    return { cert: null, reason: lastReason ?? `${kind}: no certificate found for ${host}` };
  };

  return {
    kind,
    ours,
    container,
    listSites,
    sitesByPort: async () => buildProxyRouteIndex((await listSites()).sites),
    siteFor,
    certFor: async (host) => (await certCandidateFor(host)).cert,
    certCandidateFor,
  };
}
