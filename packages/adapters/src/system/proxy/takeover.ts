/**
 * Edge takeover with config migration.
 *
 * Given the foreign proxy owning 80/443 and the sites parsed from its config,
 * this: snapshots what it's about to stop (rollback journal on disk) → stops &
 * disables the foreign proxy → installs OpenResty → re-registers the imported
 * sites as Openship routes → reuses/issues their certs → verifies. Any failure
 * rolls back (re-enable the foreign proxy) so the box is never left dark.
 *
 * The on-disk journal lets a crash mid-run be rolled back on the next boot
 * (recoverInterruptedTakeover), so an interrupted migrate can't strand 80/443.
 */

import { safeErrorMessage } from "@repo/core";
import type { CommandExecutor, ManualCert } from "../../types";
import type { RoutingProvider, SslProvider } from "../../infra/types";
import type { EdgeStatus, ImportedSite, SystemLog, SystemLogCallback } from "../types";
import { freeEdgeTargets, sq, stopTargetsForStatus } from "./detect";
import { buildJournal, clearJournal, rollback, writeJournal } from "./takeover-journal";
import { installOpenResty } from "../installer";
import { checkOpenResty } from "../checks";
import { NginxProvider } from "../../infra/nginx";
import { detectOpenRestyPaths } from "../../infra/openresty-lua";

const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/** A filesystem path safe to pass to the shell (absolute, no metacharacters). */
function isSafePath(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(p);
}

async function tryExec(executor: CommandExecutor, cmd: string): Promise<string | null> {
  try {
    return await executor.exec(cmd);
  } catch {
    return null;
  }
}

export interface EdgeTakeoverOptions {
  status: EdgeStatus;
  sites: ImportedSite[];
  acmeEmail?: string;
  /** Extra routes to register beyond the imported sites (e.g. the control plane's own hostname). */
  extraRoutes?: Array<{ domain: string; targetUrl: string; tls: boolean }>;
}

export interface EdgeTakeoverResult {
  ok: boolean;
  rolledBack: boolean;
  registered: string[];
  warnings: string[];
}

export interface RegisterImportedSitesOptions {
  onLog: SystemLogCallback;
  /** Accumulates per-domain problems (unsupported names, TLS-not-ready, errors). */
  warnings: string[];
  /**
   * Inline cert PEMs keyed by the source cert PATH (`site.tls.certPath`), for
   * callers that read the foreign certs out-of-band. The containerized edge can't
   * `cat` the HOST filesystem, so `openship up` reads the host PEMs and hands them
   * here; the host takeover leaves this unset and the certs are read via the
   * executor as before.
   */
  certPems?: Record<string, ManualCert>;
}

/**
 * Register a set of sites parsed from a foreign proxy as Openship routes on the
 * given routing/SSL provider — the executor-generic core shared by the HOST
 * takeover (`runEdgeTakeover`, NginxProvider on a LocalExecutor) and the
 * CONTAINER edge (the api's DockerEdgeExecutor provider, via the
 * `edge/import-sites` endpoint). Reuse both certs (install-if-present) and issue
 * fresh ones (provision) exactly as before; never throws — every failure is
 * collected into `opts.warnings`. Returns the domains actually registered.
 */
export async function registerImportedSites(
  routing: RoutingProvider,
  ssl: SslProvider,
  executor: CommandExecutor,
  sites: ImportedSite[],
  opts: RegisterImportedSitesOptions,
): Promise<string[]> {
  const registered: string[] = [];
  for (const site of sites) {
    const domains = site.serverNames.filter((d) => {
      if (DOMAIN_RE.test(d) && d.length <= 253) return true;
      opts.warnings.push(`skipped unsupported domain "${d}" (wildcards/regex names aren't migratable)`);
      return false;
    });

    for (const domain of domains) {
      try {
        if (site.target.kind === "proxy") {
          // Non-root locations become path-prefix proxy locations ahead of `/`
          // so a fan-out vhost (`/ → A`, `/v3 → B`) is kept, not collapsed.
          const proxyLocations = (site.routes ?? [])
            .filter((r) => r.path !== "/")
            .map((r) => ({ pathPrefix: r.path, targetUrl: r.url }));
          await routing.registerRoute({
            domain,
            tls: site.ssl,
            targetUrl: site.target.url,
            ...(proxyLocations.length ? { proxyLocations } : {}),
          });
        } else {
          await routing.registerRoute({ domain, tls: site.ssl, staticRoot: site.target.root });
        }

        if (site.ssl) {
          const manual = await resolveCert(executor, site, domain, opts);
          if (manual) {
            await ssl.installCert(domain, manual);
          } else {
            const r = await ssl.provisionCert(domain);
            if (!r.verified) opts.warnings.push(`${domain}: TLS not ready yet (${r.reason ?? "pending"})`);
          }
        }

        opts.onLog(log(`Migrated ${domain} → ${site.target.kind === "proxy" ? site.target.url : site.target.root}`));
        registered.push(domain);
      } catch (err) {
        opts.warnings.push(`${domain}: ${safeErrorMessage(err)}`);
      }
    }
  }
  return registered;
}

/**
 * The cert material for a site, or null to fall back to a fresh certbot cert.
 * Prefers inline PEMs (already vetted by the caller that read them); otherwise
 * reads the foreign cert via the executor, but only when BOTH paths are safe
 * absolute paths (they come from parsing untrusted config — never shell them raw).
 */
async function resolveCert(
  executor: CommandExecutor,
  site: ImportedSite,
  domain: string,
  opts: RegisterImportedSitesOptions,
): Promise<ManualCert | null> {
  if (!site.tls) return null;
  const inline = opts.certPems?.[site.tls.certPath];
  if (inline) return inline;
  if (!isSafePath(site.tls.certPath) || !isSafePath(site.tls.keyPath)) {
    opts.warnings.push(`${domain}: existing cert path looks unsafe — issuing a fresh certificate instead`);
    return null;
  }
  const certPem = await tryExec(executor, `cat ${sq(site.tls.certPath)} 2>/dev/null`);
  const keyPem = await tryExec(executor, `cat ${sq(site.tls.keyPath)} 2>/dev/null`);
  return certPem && keyPem ? { certPem, keyPem } : null;
}

/**
 * Stop the foreign proxy, install OpenResty, and re-register the imported sites.
 * Rolls back on failure. Assumes the caller already has explicit user consent.
 */
export async function runEdgeTakeover(
  executor: CommandExecutor,
  opts: EdgeTakeoverOptions,
  onLog: SystemLogCallback,
): Promise<EdgeTakeoverResult> {
  const warnings: string[] = [];
  const journal = await buildJournal(executor, opts.status);
  await writeJournal(executor, journal);

  onLog(log(`Migrating ${opts.sites.length} site(s) from the existing proxy, then taking over 80/443...`));
  // Same snapshot-then-free as beginEdgeTakeover; kept inline because this
  // function holds the journal in memory for its own rollback (a best-effort
  // journal WRITE can fail, and an in-process rollback must still work).
  await freeEdgeTargets(executor, stopTargetsForStatus(opts.status), (m, l) => onLog(log(m, l)));

  // Install OpenResty (ports are now free; takeover authorized as a backstop).
  const install = await installOpenResty(executor, onLog, {
    edgePolicy: { mode: "takeover", stopTargets: [] },
  });
  if (!install.success) {
    await rollback(executor, journal, onLog);
    await clearJournal(executor);
    return { ok: false, rolledBack: true, registered: [], warnings: [install.error ?? "OpenResty install failed"] };
  }

  try {
    const paths = await detectOpenRestyPaths(executor);
    const nginx = new NginxProvider({ paths, executor, acmeEmail: opts.acmeEmail });

    const registered = await registerImportedSites(nginx, nginx, executor, opts.sites, { onLog, warnings });

    for (const route of opts.extraRoutes ?? []) {
      try {
        await nginx.registerRoute({ domain: route.domain, tls: route.tls, targetUrl: route.targetUrl });
        if (route.tls) await nginx.provisionCert(route.domain);
        registered.push(route.domain);
      } catch (err) {
        warnings.push(`${route.domain}: ${safeErrorMessage(err)}`);
      }
    }

    const health = await checkOpenResty(executor);
    if (!health.healthy) {
      warnings.push(`OpenResty came up but isn't fully healthy: ${health.message}`);
    }

    // Mark done BEFORE clearing so a crash in the tiny window here (or a failed
    // clear) is recognized as complete rather than rolled back.
    journal.completed = true;
    await writeJournal(executor, journal);
    await clearJournal(executor);
    onLog(log(`Takeover complete — ${registered.length} route(s) now served by Openship.`));
    return { ok: true, rolledBack: false, registered, warnings };
  } catch (err) {
    warnings.push(safeErrorMessage(err));
    await rollback(executor, journal, onLog);
    await clearJournal(executor);
    return { ok: false, rolledBack: true, registered: [], warnings };
  }
}
