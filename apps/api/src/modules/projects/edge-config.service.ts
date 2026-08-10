/**
 * Read back what the edge is ACTUALLY serving for a project's hostnames, and
 * compare it to what the project saved.
 *
 * Saved-equals-served is an assumption, not a fact: a hand-edited vhost, a
 * half-applied reload, a value the API accepted but the sanitizer later dropped,
 * or a directive skipped by the box's nginx version floor all leave the stored
 * settings describing a config the box doesn't have. Nothing surfaced that — the
 * UI echoed the row back to the operator and looked correct. This parses the live
 * vhost through the SAME table the renderer writes it from, so the two views are
 * comparable by construction.
 *
 * Read-only and fail-soft: an unreachable box reports `reachable: false`, never an
 * error. Self-hosted only (there is no OpenResty to read on cloud).
 */

import { repos, type Project } from "@repo/db";
import {
  PROXY_DIRECTIVES,
  expectedProxyState,
  sanitizeProxySettings,
  type ProxyDirectiveGroup,
  type ProxySettings,
} from "@repo/core";
import { edgeProxy, detectOpenRestyPaths, type ImportedSite } from "@repo/adapters";

import { withServerHostExecutor } from "../../lib/edge-host-executor";

/** One directive's saved-vs-served state. */
export interface EdgeDirectiveState {
  key: string;
  directive: string;
  group: ProxyDirectiveGroup;
  /** What a vhost rendered from the project's settings would carry (companions included). */
  expected?: string | number | boolean;
  /** The live value, when it survived validation (i.e. it is adoptable as-is). */
  live?: string | number | boolean;
  /**
   * The live value exactly as the config declares it. Present even when `live` is
   * absent — a foreign vhost may legally hold `20M` or `1d`, and reporting "not
   * set" for a limit that IS set is the one thing this endpoint must never do.
   */
  liveRaw?: string;
  drift: boolean;
}

export interface EdgeConfigHostState {
  hostname: string;
  /** A vhost for this hostname was found on the box. */
  found: boolean;
  /** Whether the live vhost terminates TLS (decides whether `http2` is expected). */
  tls: boolean;
  directives: EdgeDirectiveState[];
  /** Live values that differ from expected AND are valid to store — the "adopt" payload. */
  adoptable: ProxySettings;
  driftCount: number;
}

export interface EdgeConfigReport {
  /** False when the project has no server, the box is unreachable, or no proxy reads back. */
  reachable: boolean;
  /** Which proxy answered, and whether it is our own OpenResty. */
  proxyKind?: string;
  ours?: boolean;
  /** nginx version on the box, when detectable — the `http2` floor depends on it. */
  nginxVersion?: string;
  /** The project's stored tunables, sanitized (what the UI's form is bound to). */
  saved: ProxySettings;
  hosts: EdgeConfigHostState[];
}

function buildHostState(
  hostname: string,
  site: ImportedSite | null,
  saved: ProxySettings,
  nginxVersion: readonly [number, number, number] | null,
): EdgeConfigHostState {
  const tls = site?.ssl ?? false;
  const expected = expectedProxyState(saved, { tls, nginxVersion });
  const live = (site?.proxy ?? {}) as Record<string, string | number | boolean>;
  const liveRaw = site?.proxyRaw ?? {};

  const directives: EdgeDirectiveState[] = [];
  const adoptable: Record<string, string | number | boolean> = {};

  for (const spec of PROXY_DIRECTIVES) {
    const exp = expected[spec.key];
    const got = live[spec.key];
    const raw = liveRaw[spec.key];
    // Nothing on either side — not a row worth showing.
    if (exp === undefined && got === undefined && raw === undefined) continue;

    // No vhost on the box means "we can't tell", not "the value is missing":
    // reporting drift for a project that hasn't deployed yet would cry wolf.
    const drift = site !== null && (exp !== got || (exp === undefined && raw !== undefined));
    directives.push({
      key: spec.key,
      directive: spec.directive,
      group: spec.group,
      ...(exp !== undefined ? { expected: exp } : {}),
      ...(got !== undefined ? { live: got } : {}),
      ...(raw !== undefined ? { liveRaw: raw } : {}),
      drift,
    });
    if (drift && got !== undefined) adoptable[spec.key] = got;
  }

  return {
    hostname,
    found: site !== null,
    tls,
    directives,
    adoptable: (sanitizeProxySettings(adoptable) ?? {}) as ProxySettings,
    driftCount: directives.filter((d) => d.drift).length,
  };
}

/**
 * Read the live edge config for every hostname the project owns.
 *
 * Hostnames come from the project's domain rows — the same source
 * `pushProjectRules` uses — so this reports on exactly the hosts the edge has
 * vhosts for, free subdomains included.
 */
export async function readProjectEdgeConfig(project: Project): Promise<EdgeConfigReport> {
  const saved = sanitizeProxySettings(project.routingConfig?.proxy) ?? {};

  if (project.cloudWorkspaceId) return { reachable: false, saved, hosts: [] };

  const domains = await repos.domain.listByProject(project.id).catch(() => []);
  const hostnames = [...new Set(domains.map((d) => d.hostname.toLowerCase()))].sort();
  if (hostnames.length === 0) return { reachable: false, saved, hosts: [] };

  const read = await withServerHostExecutor(project, async (exec) => {
    const proxy = await edgeProxy(exec);
    if (!proxy) return null;
    // The version floor decides whether `http2 on;` is even expected on this box;
    // without it a 1.24 host would report permanent drift on a setting the renderer
    // deliberately skipped. Detection is best-effort — unknown means default-allow,
    // exactly as the renderer treats it.
    const version = proxy.ours
      ? await detectOpenRestyPaths(exec)
          .then((p) => p.nginxVersion ?? null)
          .catch(() => null)
      : null;
    const hosts: EdgeConfigHostState[] = [];
    for (const hostname of hostnames) {
      const site = await proxy.siteFor(hostname).catch(() => null);
      hosts.push(buildHostState(hostname, site, saved, version));
    }
    return { kind: proxy.kind, ours: proxy.ours, version, hosts };
  }).catch(() => null);

  if (!read) return { reachable: false, saved, hosts: [] };
  return {
    reachable: true,
    proxyKind: read.kind,
    ours: read.ours,
    ...(read.version ? { nginxVersion: read.version.join(".") } : {}),
    saved,
    hosts: read.hosts,
  };
}
