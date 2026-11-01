/**
 * Import a containerized Traefik's routes into normalized ImportedSites.
 *
 * Traefik is LABEL-driven: app containers carry
 *   traefik.http.routers.<r>.rule    = Host(`a.com`) [&& PathPrefix(`/api`)]
 *   traefik.http.routers.<r>.service = <svc>
 *   traefik.http.routers.<r>.tls     = true
 *   traefik.http.services.<svc>.loadbalancer.server.port = 3000
 * Traefik discovers these across ALL containers, so the caller passes every
 * container's labels + its resolved IP. This module is PURE (no I/O) — the
 * docker-inspect that gathers the inputs lives in the scan wrapper.
 *
 * Host/Path/PathPrefix rules become the shared per-location route model.
 * Unsupported matchers are reported rather than widened into a Host-only route.
 *
 * Three things here exist because the naive reading of labels loses sites:
 *
 *   1. The canonical compose pattern is TWO routers per host — a `web`
 *      entrypoint one whose middleware redirects to https, and a `websecure` one
 *      carrying the real TLS. Emitting both yields two sites with the SAME
 *      hostname, and one-vhost-file-per-host downstream means the plain-HTTP half
 *      can overwrite the TLS half. `collapseByHost` decides the winner here.
 *   2. Label keys are case-INSENSITIVE to Traefik (`loadBalancer` ≡
 *      `loadbalancer`), and both spellings are in the wild. Matching only the
 *      lowercase form silently missed the port and fell back to :80.
 *   3. Services and middlewares are resolved GLOBALLY across containers, because
 *      Traefik merges every container's labels into one config — a router on
 *      container A may legitimately name a service defined on container B.
 */

import type { CommandExecutor } from "../../../types";
import type { ImportedSite, ProxyScanResult } from "../../types";
import { collapseByHost, tryExec } from "./parse-utils";
import { parseTraefikRule } from "./traefik-rules";

export interface TraefikContainer {
  /** Container name — for the ImportedSite.source trace. */
  name: string;
  /** All docker labels on the container. */
  labels: Record<string, string>;
  /** Resolved container IP (from docker inspect) for the upstream URL. Kept for
   *  the single-network case; `networks` wins when `traefik.docker.network` names one. */
  ip?: string;
  /** network name → IP. Needed because a container on several networks has
   *  several IPs and `traefik.docker.network` says which one Traefik dials. */
  networks?: Record<string, string>;
  /** Exposed container ports ("3000/tcp"). Traefik selects the lowest TCP port
   *  when no service port label is given. */
  exposedPorts?: string[];
  /** The container's command line — only read for the Traefik container itself,
   *  to spot static-config flags that change what we're allowed to conclude. */
  cmd?: string;
}

/** Traefik lowercases label keys before matching, so `loadBalancer` and
 *  `loadbalancer` are the same knob. Compare on a lowercased copy. */
function lowerKeys(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) out[k.toLowerCase()] = v;
  return out;
}

/** Pull backtick- (or quote-) quoted hostnames out of a `Host(...)` matcher. */
function extractHosts(rule: string): string[] {
  const hosts: string[] = [];
  // Host(`a.com`, `b.com`) — traefik uses backticks; tolerate quotes too.
  for (const call of rule.matchAll(/\bHost\(([^)]*)\)/gi)) {
    for (const m of call[1].matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
      const h = m[1].trim();
      if (h) hosts.push(h);
    }
  }
  return [...new Set(hosts)];
}

interface ServiceDef {
  port?: string;
  container: TraefikContainer;
  ambiguous?: boolean;
  /** `https` when the backend speaks TLS — the upstream URL scheme must follow,
   *  or the proxy talks plaintext to a TLS port and every request fails. */
  scheme?: string;
}

interface Definitions {
  services: Map<string, ServiceDef>;
  /** Middlewares that are a scheme redirect — the tell for the throwaway
   *  http→https router half. */
  redirectMiddlewares: Set<string>;
  /** `tcp`/`udp` routers, which cannot become an HTTP vhost. */
  streamRouters: string[];
  /** True when Traefik also reads a file provider: those routes are NOT in any
   *  label and would otherwise go missing without a word. */
  fileProvider: boolean;
  /** `--providers.docker.exposedByDefault=false` — containers without an
   *  explicit `traefik.enable=true` are NOT served, so they must not migrate. */
  exposedByDefault: boolean;
}

/** Pass 1 — everything that is global to the Traefik config, not per-container. */
function collectDefinitions(containers: TraefikContainer[]): Definitions {
  const services = new Map<string, ServiceDef>();
  const redirectMiddlewares = new Set<string>();
  const streamRouters: string[] = [];
  const fileProvider = containers.some((c) => /--?providers\.file/i.test(c.cmd ?? ""));
  const exposedByDefault = !containers.some((c) => /--?providers\.docker\.exposedbydefault[= ]?false/i.test(c.cmd ?? ""));

  for (const c of containers) {
    const labels = lowerKeys(c.labels);
    if (labels["traefik.enable"] === "false" || (!exposedByDefault && labels["traefik.enable"] !== "true")) continue;
    for (const [k, v] of Object.entries(labels)) {
      let m = k.match(/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.(port|scheme)$/);
      if (m) {
        const def: ServiceDef = services.get(m[1]) ?? { container: c };
        if (def.container !== c) def.ambiguous = true;
        if (m[2] === "port") def.port = v;
        else def.scheme = v;
        services.set(m[1], def);
        continue;
      }
      m = k.match(/^traefik\.http\.middlewares\.([^.]+)\.redirectscheme\./);
      if (m) {
        redirectMiddlewares.add(m[1]);
        continue;
      }
      m = k.match(/^traefik\.(tcp|udp)\.routers\.([^.]+)\.rule$/);
      if (m) streamRouters.push(`${m[1]} router "${m[2]}"`);
    }

  }

  return { services, redirectMiddlewares, streamRouters, fileProvider, exposedByDefault };
}

/** Which IP Traefik would actually dial for this container. */
function resolveIp(c: TraefikContainer, labels: Record<string, string>): string | undefined {
  const wanted = labels["traefik.docker.network"];
  // An explicit network is a hard choice: picking a different one produces an
  // upstream that is reachable from nowhere.
  if (wanted && c.networks?.[wanted]) return c.networks[wanted];
  if (c.ip) return c.ip;
  const first = Object.values(c.networks ?? {}).find(Boolean);
  return first || undefined;
}

/** A route we might migrate, before same-host collisions are resolved. */
interface Candidate {
  hosts: string[];
  ssl: boolean;
  url: string;
  container: string;
  router: string;
  path: string;
  exact?: boolean;
  middlewares: string[];
  /** Every middleware on it is a scheme redirect → this is the throwaway
   *  http→https half, not a site. */
  redirectOnly: boolean;
}

export function parseTraefikLabels(containers: TraefikContainer[]): ProxyScanResult {
  const warnings: string[] = [];
  const defs = collectDefinitions(containers);
  const candidates: Candidate[] = [];

  for (const c of containers) {
    const labels = lowerKeys(c.labels);
    if (labels["traefik.enable"] === "false") continue; // opted out
    // With exposedByDefault=false, silence means "not served" — importing such a
    // container would resurrect a route the operator had switched off.
    if (!defs.exposedByDefault && labels["traefik.enable"] !== "true") continue;

    const routers = new Map<string, Record<string, string>>();
    for (const [key, val] of Object.entries(labels)) {
      const r = key.match(/^traefik\.http\.routers\.([^.]+)\.(.+)$/);
      if (!r) continue;
      const bag = routers.get(r[1]) ?? {};
      bag[r[2]] = val;
      routers.set(r[1], bag);
    }

    for (const [rname, props] of routers) {
      const rule = props.rule;
      if (!rule) continue;

      const hosts = extractHosts(rule);
      if (hosts.length === 0) {
        warnings.push(
          /HostRegexp/i.test(rule)
            ? `traefik: router "${rname}" uses HostRegexp (${rule}) — regex hosts aren't migratable`
            : `traefik: router "${rname}" has no Host() rule (${rule}) — skipped`,
        );
        continue;
      }

      const matches = parseTraefikRule(rule);
      if (!matches || matches.some((match) => !match.hosts?.length)) {
        warnings.push(`traefik: router "${rname}" uses an unsupported rule (${rule}) — it must be recreated manually; no broader Host-only route was imported`);
        continue;
      }

      const serviceRef = props.service?.toLowerCase();
      if (serviceRef?.includes("@") && !serviceRef.endsWith("@docker")) {
        warnings.push(`traefik: router "${rname}" uses ${props.service} outside the Docker provider — configure its upstream manually`);
        continue;
      }
      const svc = serviceRef?.replace(/@docker$/, "");
      const ownServices = [...defs.services.values()].filter((def) => def.container === c);
      const def = svc ? defs.services.get(svc) : ownServices.length === 1 ? ownServices[0] : undefined;
      if ((svc && !def) || def?.ambiguous || (!svc && ownServices.length > 1)) {
        warnings.push(`traefik: router "${rname}" has no unambiguous Docker service — configure its upstream manually`);
        continue;
      }
      const target = def?.container ?? c;
      const ip = resolveIp(target, lowerKeys(target.labels));
      if (!ip) {
        warnings.push(
          `traefik: ${hosts.join(", ")} — couldn't resolve container ${target.name}'s IP; re-add the upstream manually`,
        );
        continue;
      }

      // Docker provider fallback: the lowest exposed TCP port of the BACKEND.
      const exposed = (target.exposedPorts ?? []).filter((port) => /^\d+\/tcp$/.test(port))
        .map((port) => Number(port.split("/")[0])).sort((a, b) => a - b);
      const rawPort = def?.port ?? exposed[0];
      const port = Number(rawPort);
      if (!/^\d{1,5}$/.test(String(rawPort)) || !Number.isInteger(port) || port < 1 || port > 65535) {
        warnings.push(`traefik: router "${rname}" has no valid backend port — configure its upstream manually`);
        continue;
      }
      const scheme = def?.scheme?.toLowerCase() === "https" ? "https" : "http";

      const middlewares = (props.middlewares ?? "")
        .split(",")
        .map((m) => m.trim().replace(/@.*$/, ""))
        .filter(Boolean);

      for (const match of matches) candidates.push({
        hosts: match.hosts!,
        path: match.path ?? "/",
        ...(match.exact ? { exact: true } : {}),
        ssl: props.tls !== "false" && Object.keys(props).some((p) => p === "tls" || p.startsWith("tls.")),
        url: `${scheme}://${ip.includes(":") ? `[${ip}]` : ip}:${port}`,
        container: target.name,
        router: rname,
        middlewares,
        redirectOnly:
          middlewares.length > 0 && middlewares.every((m) => defs.redirectMiddlewares.has(m)),
      });
    }
  }

  // redirectOnly scores a flat 0 (never beats a real router, and among an
  // all-redirect group the first is kept by source order — same as before);
  // among real routers the TLS one wins, ties keep source order.
  const { kept: sites, dropped } = collapseByHost(
    candidates.flatMap((candidate) => candidate.hosts.map((host) => ({ ...candidate, hosts: [host] }))),
    (c) => [`${c.hosts[0]}\0${c.path}\0${Boolean(c.exact)}`],
    (c) => (c.redirectOnly ? 0 : c.ssl ? 2 : 1),
  );

  // Warn only about SURVIVORS: a dropped redirect half would otherwise warn
  // "uses middleware(s) redirect-to-https — not migrated", which is noise about
  // config we reproduce natively.
  for (const cand of sites) {
    const carried = cand.middlewares.filter((m) => !defs.redirectMiddlewares.has(m));
    if (carried.length > 0) {
      warnings.push(
        `traefik: ${cand.hosts.join(", ")} uses middleware(s) "${carried.join(", ")}" — not migrated`,
      );
    }
  }
  for (const d of dropped) {
    // Not silent: the operator should know we recognised it, not wonder if it
    // was missed. Distinct wording from a real loss.
    warnings.push(
      d.redirectOnly
        ? `traefik: ${d.hosts.join(", ")} router "${d.router}" is an http→https redirect — Openship's edge does that itself (nothing to migrate)`
        : `traefik: ${d.hosts.join(", ")} router "${d.router}" duplicates the same hostname/path — the preferred router was retained`,
    );
  }
  for (const s of defs.streamRouters) {
    warnings.push(`traefik: ${s} can't migrate — Openship's edge routes HTTP(S), not raw TCP/UDP`);
  }
  if (defs.fileProvider) {
    warnings.push(
      "traefik: a file provider is configured — routes defined in its YAML/TOML files are NOT read here, only container labels. Re-add those domains manually.",
    );
  }

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of sites) {
    const group = grouped.get(candidate.hosts[0]) ?? [];
    group.push(candidate);
    grouped.set(candidate.hosts[0], group);
  }
  const imported = new Map<string, ImportedSite>();
  for (const [hostname, routes] of grouped) {
    const root = routes.find((route) => route.path === "/" && !route.exact);
    // The primary target identifies the site; only the explicit route table
    // defines its paths. Takeover uses a 404 root when no catch-all was found.
    const primary = root ?? routes[0]!;
    const site: ImportedSite = {
      serverNames: [hostname],
      ssl: routes.some((route) => route.ssl),
      target: { kind: "proxy", url: primary.url },
      ...(!root || routes.length > 1 ? { routes: routes.map((route) => ({
        path: route.path, url: route.url, ...(route.exact ? { exact: true } : {}),
      })) } : {}),
      source: `traefik container ${primary.container}`,
    };
    const key = JSON.stringify([site.target, site.ssl, site.routes, site.source]);
    const alias = imported.get(key);
    if (alias) alias.serverNames.push(hostname);
    else imported.set(key, site);
  }
  return {
    proxy: "traefik",
    sites: [...imported.values()],
    warnings,
  };
}

/**
 * I/O wrapper: gather every running container's labels + IP via `docker inspect`
 * (traefik routers can live on ANY container, not just the traefik one), then
 * run the pure parser. Executor-based (docker CLI) so the proxy module stays free
 * of a DockerRuntime dependency. Best-effort — never throws.
 */
export async function scanTraefik(executor: CommandExecutor): Promise<ProxyScanResult> {
  // Tab-delimited so a label value containing our separator can't shift columns.
  // Networks are `name=ip` pairs (traefik.docker.network picks one) and Cmd is
  // needed for the static-config flags read in collectDefinitions.
  const out = await tryExec(
    executor,
    "docker ps -q 2>/dev/null | xargs -r docker inspect " +
      "--format '{{.Name}}\t{{json .Config.Labels}}\t" +
      "{{range $n, $v := .NetworkSettings.Networks}}{{$n}}={{$v.IPAddress}} {{end}}\t" +
      "{{range $p, $v := .Config.ExposedPorts}}{{$p}} {{end}}\t" +
      "{{if .Config.Cmd}}{{join .Config.Cmd \" \"}}{{end}}' 2>/dev/null",
  );
  if (!out) {
    return { proxy: "traefik", sites: [], warnings: ["traefik: couldn't read container labels via docker inspect"] };
  }

  const containers: TraefikContainer[] = [];
  for (const line of out.split("\n")) {
    const [rawName, rawLabels, rawNets, rawPorts, rawCmd] = line.split("\t");
    if (!rawName || !rawLabels) continue;
    let labels: Record<string, string>;
    try {
      labels = (JSON.parse(rawLabels) as Record<string, string>) ?? {};
    } catch {
      continue;
    }

    // `name=ip` pairs, but tolerate a bare IP: the format string above is the
    // only producer today, yet a bare address is still a usable upstream and
    // silently dropping it would cost the whole site.
    const networks: Record<string, string> = {};
    let bareIp: string | undefined;
    for (const pair of (rawNets ?? "").trim().split(/\s+/)) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const ip = pair.slice(eq + 1);
        if (ip) networks[pair.slice(0, eq)] = ip;
      } else if (!bareIp) {
        bareIp = pair;
      }
    }
    const exposedPorts = (rawPorts ?? "").trim().split(/\s+/).filter(Boolean);

    // Traefik's OWN container carries the static config we need (file provider,
    // exposedByDefault) and usually no router labels, so it must survive the
    // label filter below.
    const hasTraefikLabels = Object.keys(labels).some((k) => k.toLowerCase().startsWith("traefik."));
    const looksLikeTraefik = /traefik/i.test(rawCmd ?? "") || /--?providers\./i.test(rawCmd ?? "");
    if (!hasTraefikLabels && !looksLikeTraefik) continue;

    containers.push({
      name: rawName.replace(/^\//, ""),
      labels,
      ip: Object.values(networks)[0] ?? bareIp,
      networks,
      exposedPorts,
      cmd: rawCmd ?? undefined,
    });
  }
  return parseTraefikLabels(containers);
}
