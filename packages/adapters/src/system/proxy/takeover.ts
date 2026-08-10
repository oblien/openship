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
import { freeEdgeTargets, resolveOurEdgeContainer, sq, stopTargetsForStatus } from "./detect";
import { collectProxyCerts, edgeProxy } from "./api";
import { isSafeCertPath, readDeclaredPair, validateCertFor } from "./cert-material";
import { buildJournal, clearJournal, rollback, writeJournal } from "./takeover-journal";
import { installContainerEdge } from "../installer";
import { containerEdgeProvider, type EdgeProviderOptions } from "./ensure-container-edge";
import { checkEdge } from "../checks";
import { NginxProvider } from "../../infra/nginx";
import { detectOpenRestyPaths } from "../../infra/openresty-lua";

const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}


export interface EdgeTakeoverOptions {
  status: EdgeStatus;
  sites: ImportedSite[];
  acmeEmail?: string;
  nginx?: EdgeProviderOptions;
  /** Extra routes to register beyond the imported sites (e.g. the control plane's own hostname). */
  extraRoutes?: Array<{ domain: string; targetUrl: string; tls: boolean }>;
  /** Pinned edge image; the API always supplies its own (never a caller's value). */
  edgeImage?: string;
  /**
   * Cert PEMs the caller already read from the source proxy, keyed by hostname or
   * cert path. When omitted this harvests them itself (before stopping the proxy —
   * see `runEdgeTakeover`). `openship up` supplies them because a containerized
   * edge can't read the host filesystem.
   */
  certPems?: Record<string, ManualCert>;
  /**
   * Corrected static docroots keyed by primary hostname, for adopted static sites
   * whose original root the containerized edge can't see. The CLI copies the tree
   * into the edge's static bind mount host-side (see `copyStaticRootIntoEdge`) and
   * passes the new root here; without it the site 500s after cutover. See #456.
   */
  staticRootOverrides?: Record<string, string>;
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
   * Inline cert PEMs for callers that read the foreign certs out-of-band. The
   * containerized edge can't `cat` the HOST filesystem, so `openship up` reads the
   * host PEMs and hands them here; the host takeover leaves this unset and the
   * certs are read via the executor.
   *
   * Keyed by the source cert PATH (`site.tls.certPath`) **or** by HOSTNAME. The
   * path key came first, but caddy and traefik keep certs in their own stores with
   * no per-site path to key on — a hostname key is the only thing that can carry
   * those, and every producer already knows the hostname.
   */
  certPems?: Record<string, ManualCert>;
  /**
   * Corrected static docroots keyed by primary hostname (`serverNames[0]`), for
   * adopted static sites the containerized edge can't reach at their original
   * root. The CLI copies the tree into the edge's static bind mount host-side and
   * supplies the new root here; substituted into `staticRoot` so the corrected
   * path is what lands in the route sidecar (and survives cert renewal). See #456.
   */
  staticRootOverrides?: Record<string, string>;
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
            // An imported site's TLS becomes ours the moment we take :443 over, and
            // its cert may not land until the carry/ACME step below. Keep a :443
            // listener up throughout: without one the domain falls through to the
            // edge's 443 catch-all mid-takeover, which since #431 answers with the
            // placeholder cert and the branded not-found page — so a live site reads
            // as "no application configured here" (#308).
            terminatesTlsLocally: site.ssl,
            targetUrl: site.target.url,
            ...(proxyLocations.length ? { proxyLocations } : {}),
            // Carry the source vhost's tunables (upload limit, upstream timeouts).
            // Taking the ports over swaps the config the site is served from, so
            // without this a 20 MB-upload site starts 413ing at nginx's 1 MB the
            // moment we bind — a regression the operator never asked for and has
            // no reason to connect to the takeover. Already sanitized by the parser.
            ...(site.proxy ? { proxy: site.proxy } : {}),
          });
        } else {
          // Adopted: this root is what the operator's own proxy was already serving, so
          // it is allowed outside the managed base (see assertValidStaticRoot). When a
          // containerized edge can't see that root, the CLI copied the tree into the
          // static bind mount and passed the corrected root here (keyed on the primary
          // hostname) — otherwise the site 500s after cutover (#456).
          await routing.registerRoute({
            domain,
            tls: site.ssl,
            terminatesTlsLocally: site.ssl,
            staticRoot: opts.staticRootOverrides?.[site.serverNames[0]] ?? site.target.root,
            staticRootAdopted: true,
            ...(site.proxy ? { proxy: site.proxy } : {}),
          });
        }

        if (site.ssl) {
          const manual = await resolveCert(executor, site, domain, opts);
          if (manual) {
            // Reuse the source's existing certificate — no ACME, no network round-trip.
            await ssl.installCert(domain, manual);
          } else {
            // The slow path: a fresh per-domain ACME issuance, serialized against
            // Let's Encrypt. This is the one step of a migrate that can take real
            // wall-clock time (and hit rate limits), so announce it BEFORE the call —
            // otherwise a migrate that's busy reissuing certs is indistinguishable
            // from a hang. The WHY (expired / unreadable / doesn't cover the host)
            // is already in `warnings` from resolveCert.
            opts.onLog(
              log(
                `${domain}: existing certificate couldn't be carried over — requesting a new one (this can take a while)…`,
                "warn",
              ),
            );
            const r = await ssl.provisionCert(domain);
            if (!r.verified) {
              // The source was serving HTTPS, but we couldn't carry its certificate
              // AND couldn't issue a fresh one — so the edge is now answering :443 with
              // the self-signed placeholder. That's invisible to a browser hitting the
              // box directly (it just warns), but a CDN fronting the origin with strict
              // origin TLS (Cloudflare "Full (strict)") REJECTS the placeholder and
              // returns a 525 with no hint of the cause. Name it here, next to the fix,
              // so the migrate log isn't the only place the operator can learn why a
              // site that worked a minute ago now 525s.
              opts.warnings.push(
                `${domain}: was serving HTTPS, but its certificate could not be carried over and a ` +
                  `new one could not be issued (${r.reason ?? "pending"}). The edge is serving a temporary ` +
                  `self-signed certificate — a CDN in front (e.g. Cloudflare "Full (strict)") will reject it ` +
                  `with a 525. Upload the origin certificate from the domain's SSL menu, or issue one via DNS-01.`,
              );
            }
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
 * The cert material to carry for a domain, or null to fall back to a fresh
 * certbot issuance.
 *
 * Inline PEMs win (the caller read them out-of-band and already vetted them),
 * keyed by cert path or hostname. Otherwise this delegates to the shared reader,
 * which validates that the cert actually covers the domain and hasn't expired —
 * this used to `cat` the paths and hand back whatever came out, so a vhost naming
 * two hosts off a single-host cert carried that cert to BOTH.
 *
 * A rejection is a warning, not a silent fallthrough: the operator was told these
 * sites would migrate, so "reissuing instead, because …" has to reach them.
 */
async function resolveCert(
  executor: CommandExecutor,
  site: ImportedSite,
  domain: string,
  opts: RegisterImportedSitesOptions,
): Promise<ManualCert | null> {
  const inline = opts.certPems?.[domain] ?? (site.tls ? opts.certPems?.[site.tls.certPath] : undefined);
  if (inline) return inline;

  if (!site.tls) return null;
  // Checked here as well as inside readDeclaredPair so the operator gets the real
  // cause — "the path in your config looks unsafe" is a different problem from
  // "the file wouldn't read", and only one of them means someone should look at
  // the config.
  if (!isSafeCertPath(site.tls.certPath) || !isSafeCertPath(site.tls.keyPath)) {
    opts.warnings.push(`${domain}: existing cert path looks unsafe — issuing a fresh certificate instead`);
    return null;
  }
  const pems = await readDeclaredPair(executor, site.tls.certPath, site.tls.keyPath);
  if (!pems) {
    opts.warnings.push(`${domain}: existing cert at ${site.tls.certPath} unreadable — issuing a fresh certificate`);
    return null;
  }
  const candidate = validateCertFor(domain, pems, site.tls.certPath);
  if (!candidate.cert) {
    opts.warnings.push(`${domain}: issuing a fresh certificate — ${candidate.reason}`);
    return null;
  }
  return { certPem: candidate.cert.certPem, keyPem: candidate.cert.keyPem };
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

  // Harvest the source proxy's certs BEFORE stopping it. A containerized caddy or
  // traefik keeps its cert store inside the container, so once it's stopped there's
  // no way left to read it and every migrated domain would silently fall back to a
  // fresh ACME issuance. Skipped when the caller already read them host-side
  // (`openship up` does, because a containerized edge can't cat the host FS).
  let certPems = opts.certPems;
  if (!certPems) {
    const source = await edgeProxy(executor, { status: opts.status }).catch(() => null);
    if (source) {
      const harvest = await collectProxyCerts(source, opts.sites);
      certPems = harvest.certPems;
      warnings.push(...harvest.warnings);
      const carried = Object.keys(harvest.certPems).length;
      if (carried > 0) onLog(log(`Carrying ${carried} existing certificate(s) from ${source.kind}.`));
    }
  }

  // Same snapshot-then-free as beginEdgeTakeover; kept inline because this
  // function holds the journal in memory for its own rollback (a best-effort
  // journal WRITE can fail, and an in-process rollback must still work).
  const freed = await freeEdgeTargets(executor, stopTargetsForStatus(opts.status), (m, l) =>
    onLog(log(m, l)),
  );
  if (!freed.freed) {
    // "I stopped its owner" is not ":80 is bindable". Installing anyway starts an
    // edge that loses the race for the socket and crash-loops on
    // `bind() … (98: Address already in use)` — while `docker run` exits 0, so this
    // function would report a successful migration of a box serving nothing.
    const plural = freed.stillBound.length > 1;
    const rolledBack = await rollback(executor, journal, onLog);
    await clearJournal(executor);
    warnings.push(
      `Stopped the existing proxy, but port${plural ? "s" : ""} ${freed.stillBound.join(" and ")} ` +
        `${plural ? "are" : "is"} still in use, so the edge can't bind — nothing was installed. ` +
        "Find what else is holding the port and retry.",
    );
    if (!rolledBack) warnings.push("The previous proxy did NOT come back — nothing is serving :80.");
    return { ok: false, rolledBack, registered: [], warnings };
  }

  // Bring up OUR edge (ports are now free; takeover authorized as a backstop).
  // Goes through the same component installer as every other path, so this is the
  // CONTAINER edge wherever Docker exists and the host install only on a box
  // without it — a takeover must not be the one flow that still needs apt.
  const install = await installContainerEdge(executor, onLog, {
    edgePolicy: { mode: "takeover", stopTargets: [] },
    edgeImage: opts.edgeImage,
  });
  if (!install.success) {
    // `rolledBack` is what the caller reports to the operator, so it carries the
    // VERIFIED outcome: false here means the box is dark, not just that the restore
    // commands ran.
    const rolledBack = await rollback(executor, journal, onLog);
    await clearJournal(executor);
    return { ok: false, rolledBack, registered: [], warnings: [install.error ?? "Edge install failed"] };
  }

  try {
    // Which edge did we just get? The migrated vhosts have to be written where THAT
    // edge reads them: the bind-mounted host dir for a container, the detected
    // OpenResty tree for a bare host. Getting this wrong writes every migrated site
    // to a directory nothing serves from — the foreign proxy is already stopped by
    // this point, so it would read as "migrated 0 sites" with the box dark.
    // `fresh` is mandatory here: the install above JUST created the container, and
    // ensureEdgeClear probed (and cached `null`) moments earlier in this same
    // teardown. A memo hit would build a BARE-paths provider and write every
    // migrated vhost where the container never reads — with the foreign proxy
    // already stopped.
    const container = await resolveOurEdgeContainer(executor, { fresh: true });
    const providerOptions = { ...opts.nginx, acmeEmail: opts.acmeEmail ?? opts.nginx?.acmeEmail };
    const nginx = container
      ? await containerEdgeProvider(executor, container, providerOptions)
      : new NginxProvider({
          paths: await detectOpenRestyPaths(executor),
          executor,
          ...providerOptions,
        });

    const registered = await registerImportedSites(nginx, nginx, executor, opts.sites, {
      onLog,
      warnings,
      ...(certPems ? { certPems } : {}),
      ...(opts.staticRootOverrides ? { staticRootOverrides: opts.staticRootOverrides } : {}),
    });

    for (const route of opts.extraRoutes ?? []) {
      try {
        await nginx.registerRoute({
          domain: route.domain,
          tls: route.tls,
          terminatesTlsLocally: route.tls,
          targetUrl: route.targetUrl,
        });
        if (route.tls) await nginx.provisionCert(route.domain);
        registered.push(route.domain);
      } catch (err) {
        warnings.push(`${route.domain}: ${safeErrorMessage(err)}`);
      }
    }

    const health = await checkEdge(executor);
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
    const rolledBack = await rollback(executor, journal, onLog);
    await clearJournal(executor);
    if (!rolledBack) warnings.push("The previous proxy did NOT come back — nothing is serving :80.");
    return { ok: false, rolledBack, registered: [], warnings };
  }
}
