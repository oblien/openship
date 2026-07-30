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
 * An OpenResty vhost carries ONE upstream per host, so only the Host() part
 * migrates; PathPrefix / Headers / Method / middlewares / HostRegexp are
 * surfaced as coverage warnings ("re-add manually"), never silently dropped.
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
  /** Exposed container ports ("3000/tcp"). Traefik falls back to the single
   *  exposed port when no service port label is given, so we must too. */
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

/** Matchers other than Host() that a single-upstream OpenResty vhost can't express. */
function extraMatchers(rule: string): string[] {
  const found = new Set<string>();
  for (const m of rule.matchAll(
    /\b(PathPrefix|PathRegexp|Path|HeadersRegexp|Headers|Method|Query|ClientIP|HostRegexp)\b/gi,
  )) {
    found.add(m[1]);
  }
  return [...found];
}

interface ServiceDef {
  port?: string;
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
  let fileProvider = false;
  let exposedByDefault = true;

  for (const c of containers) {
    const labels = lowerKeys(c.labels);
    // A disabled container's SERVICE definitions still count — Traefik merges
    // label config globally and `traefik.enable=false` only stops that container
    // being exposed as a route target of its own.
    for (const [k, v] of Object.entries(labels)) {
      let m = k.match(/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.(port|scheme)$/);
      if (m) {
        const def = services.get(m[1]) ?? {};
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

    // Static config lives on Traefik's own command line (or its env), not in
    // labels. Both flags below change what the label set can be trusted to mean.
    const cmd = c.cmd ?? "";
    if (/--?providers\.file/i.test(cmd)) fileProvider = true;
    if (/--?providers\.docker\.exposedbydefault[= ]?false/i.test(cmd)) exposedByDefault = false;
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
  rule: string;
  middlewares: string[];
  /** Every middleware on it is a scheme redirect → this is the throwaway
   *  http→https half, not a site. */
  redirectOnly: boolean;
  /** Port had to be guessed — worth saying so, since a wrong port is a 502. */
  portGuessed: boolean;
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

      const ip = resolveIp(c, labels);
      if (!ip) {
        warnings.push(
          `traefik: ${hosts.join(", ")} — couldn't resolve container ${c.name}'s IP; re-add the upstream manually`,
        );
        continue;
      }

      // Port: the router's own service → the only service defined anywhere → the
      // container's only exposed port (what Traefik itself falls back to) → 80.
      const svc = props.service?.replace(/@.*$/, "");
      const def =
        (svc ? defs.services.get(svc) : undefined) ??
        (defs.services.size === 1 ? [...defs.services.values()][0] : undefined);
      const onlyExposed =
        c.exposedPorts?.length === 1 ? c.exposedPorts[0].split("/")[0] : undefined;
      const rawPort = def?.port ?? onlyExposed;
      // The port originates from a container label — accept only digits so it
      // can't inject characters into the generated proxy target (defence-in-depth;
      // the nginx layer rejects them too).
      const port = /^\d{1,5}$/.test(String(rawPort)) ? String(rawPort) : "80";
      const scheme = def?.scheme?.toLowerCase() === "https" ? "https" : "http";

      const middlewares = (props.middlewares ?? "")
        .split(",")
        .map((m) => m.trim().replace(/@.*$/, ""))
        .filter(Boolean);

      candidates.push({
        hosts,
        ssl: Object.keys(props).some((p) => p === "tls" || p.startsWith("tls.")),
        url: `${scheme}://${ip}:${port}`,
        container: c.name,
        router: rname,
        rule,
        middlewares,
        redirectOnly:
          middlewares.length > 0 && middlewares.every((m) => defs.redirectMiddlewares.has(m)),
        portGuessed: rawPort === undefined,
      });
    }
  }

  // redirectOnly scores a flat 0 (never beats a real router, and among an
  // all-redirect group the first is kept by source order — same as before);
  // among real routers the TLS one wins, ties keep source order.
  const { kept: sites, dropped } = collapseByHost(
    candidates,
    (c) => c.hosts,
    (c) => (c.redirectOnly ? 0 : c.ssl ? 2 : 1),
  );

  // Warn only about SURVIVORS: a dropped redirect half would otherwise warn
  // "uses middleware(s) redirect-to-https — not migrated", which is noise about
  // config we reproduce natively.
  for (const cand of sites) {
    const extras = extraMatchers(cand.rule);
    if (extras.length > 0) {
      warnings.push(
        `traefik: ${cand.hosts.join(", ")} also matches ${extras.join(", ")} — only the Host() part is migrated; re-add path/header rules manually`,
      );
    }
    const carried = cand.middlewares.filter((m) => !defs.redirectMiddlewares.has(m));
    if (carried.length > 0) {
      warnings.push(
        `traefik: ${cand.hosts.join(", ")} uses middleware(s) "${carried.join(", ")}" — not migrated`,
      );
    }
    if (cand.portGuessed) {
      warnings.push(
        `traefik: ${cand.hosts.join(", ")} — no service port label and no single exposed port on ${cand.container}; assumed :80, check the upstream`,
      );
    }
  }
  for (const d of dropped) {
    // Not silent: the operator should know we recognised it, not wonder if it
    // was missed. Distinct wording from a real loss.
    warnings.push(
      `traefik: ${d.hosts.join(", ")} router "${d.router}" is an http→https redirect — Openship's edge does that itself (nothing to migrate)`,
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

  return {
    proxy: "traefik",
    sites: sites.map((cand) => ({
      serverNames: cand.hosts,
      ssl: cand.ssl,
      target: { kind: "proxy" as const, url: cand.url },
      source: `traefik container ${cand.container}`,
    })),
    warnings,
  };
}

/**
 * One vhost per hostname downstream, so two routers sharing a Host() collide and
 * the loser is silently gone. Resolve it here: drop the redirect-only halves when
 * a real router exists for the same host, then prefer TLS.
 *
 * Keeps a redirect-only router if it is the ONLY thing serving that host —
 * dropping it would lose the hostname entirely.
 */
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
