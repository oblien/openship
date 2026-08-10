/**
 * Parse an existing nginx config into normalized ImportedSites.
 *
 * Prefers `nginx -T` (dumps the fully-resolved config with all includes),
 * falling back to catting sites-enabled + conf.d. Best-effort: anything we
 * can't interpret is returned as a warning, never silently dropped.
 */

import {
  PROXY_DIRECTIVES,
  parseProxyValue,
  sanitizeProxySettings,
  type ProxySettings,
} from "@repo/core";

import type { CommandExecutor } from "../../../types";
import type { ImportedSite, ProxyScanResult } from "../../types";
import { EDGE_HOST_PATHS, OPENRESTY_DEFAULT_PATHS } from "../../../infra/openresty-lua";
import { containerCommand } from "../../edge-container-executor";
import { resolveOurEdgeContainer } from "../detect";
import { collapseByHost, extractBlocks, stripComments, tryExec } from "./parse-utils";

/**
 * The fully-resolved config dump from the first of `bins` that yields one. `-T`
 * inlines every `include`, so a cert in a snippet (`include snippets/ssl-<host>.conf`)
 * or a vhost kept under a custom `--conf-path`/conf.d is visible — a plain cat of the
 * top-level files sees NEITHER. It reads config off disk without touching the running
 * master, so it works for a proxy a takeover already stopped. Null when no binary
 * produces a server block.
 *
 * `nginx` and `openresty` are different binaries: an OpenResty box usually has no
 * `nginx` on PATH, so both are worth trying (in caller-chosen order). Skipping the
 * `openresty` attempt is how an OpenResty box silently dropped to the include-blind
 * cat and lost every snippet-declared cert — the edge then served the self-signed
 * placeholder on :443 and a fronting Cloudflare in Full/Strict answered 525.
 */
async function dumpResolvedConfig(
  executor: CommandExecutor,
  bins: string[],
): Promise<string | null> {
  for (const bin of bins) {
    const dumped = await tryExec(executor, `${bin} -T 2>/dev/null`);
    if (dumped && /server\s*\{/.test(dumped)) return dumped;
  }
  return null;
}

async function loadNginxConfig(executor: CommandExecutor): Promise<string> {
  const dumped = await dumpResolvedConfig(executor, ["nginx", "openresty"]);
  if (dumped) return dumped;
  // Fallback: concatenate the usual include targets. Include-blind — a cert in a
  // snippet won't be seen here, which is why the `-T` dumps above are tried first.
  const cat = await tryExec(
    executor,
    "cat /etc/nginx/nginx.conf /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null",
  );
  return cat ?? "";
}

function firstDirective(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${name}\\s+([^;]+);`));
  return m?.[1]?.trim();
}

/** Parse `upstream <name> { server <host:port>; ... }` → name → first host:port. */
function parseUpstreams(config: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:^|[\s;}])upstream\s+(\S+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(config)) !== null) {
    const name = m[1];
    const server = m[2].match(/(?:^|[\s;{])server\s+([^;\s]+)/);
    if (name && server?.[1]) map.set(name, server[1].trim());
  }
  return map;
}

/**
 * Turn a raw proxy_pass value into a concrete Openship route target, or reject
 * it (so the caller warns and skips) when it can't be resolved to a real
 * host:port — an unknown/undeclared upstream, an nginx variable, or a unix
 * socket would otherwise produce a vhost that fails `openresty -t`.
 */
function resolveProxyTarget(
  proxyPass: string,
  upstreams: Map<string, string>,
): { url: string } | { reason: string } {
  const raw = proxyPass.replace(/;$/, "").trim();
  if (raw.includes("$")) return { reason: `proxy_pass "${raw}" uses an nginx variable` };
  if (/\/\/unix:/i.test(raw)) return { reason: `proxy_pass "${raw}" targets a unix socket` };
  const m = raw.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
  if (!m) return { reason: `unrecognized proxy_pass "${raw}"` };
  const scheme = m[1];
  const authority = m[2];
  const host = authority.replace(/:\d+$/, "");
  if (upstreams.has(host)) return { url: `${scheme}${upstreams.get(host)}` };
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  // `localhost` is NOT safe to carry over verbatim: nginx resolves it to ::1
  // first, and most app servers bind IPv4 only — so an adopted
  // `proxy_pass http://localhost:4000` 502s with "connect() failed (111) …
  // upstream: http://[::1]:4000". Pin the family the app actually listens on.
  // (An app bound ONLY to ::1 is rare enough to be worth this trade.)
  if (host === "localhost" || host === "ip6-localhost") {
    return { url: raw.replace(/^(https?:\/\/)[^/:]+/i, "$1127.0.0.1") };
  }
  if (isIp || host.includes(".")) return { url: raw };
  return { reason: `proxy_pass host "${host}" is an undeclared upstream — not migratable` };
}

/**
 * Every `location <path> { … }` in a server block with its body, in source order.
 * Balanced-brace matched so a nested `if {}` / `types {}` inside a location doesn't
 * truncate it.
 */
function locationBlocks(serverBody: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const re = /(?:^|[\s;}])location\s+([^{]+?)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(serverBody)) !== null) {
    const path = m[1].trim();
    const openIdx = m.index + m[0].length - 1; // the `{`
    let depth = 1;
    let i = openIdx + 1;
    for (; i < serverBody.length && depth > 0; i++) {
      if (serverBody[i] === "{") depth++;
      else if (serverBody[i] === "}") depth--;
    }
    if (depth !== 0) break; // unbalanced — stop
    out.push({ path, body: serverBody.slice(openIdx + 1, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/**
 * `location <path> { … proxy_pass … }` targets within a server block, in source
 * order. `proxy_pass` is only valid inside a location (or `if`) in nginx, so
 * this — not a server-level scan — is where real routes live.
 */
function extractLocationProxies(serverBody: string): { path: string; proxyPass: string }[] {
  const out: { path: string; proxyPass: string }[] = [];
  for (const loc of locationBlocks(serverBody)) {
    const pp = firstDirective(loc.body, "proxy_pass");
    if (pp) out.push({ path: loc.path, proxyPass: pp });
  }
  return out;
}

/** Blank out quoted tokens so a directive-shaped word inside a VALUE can't be read
 *  as a directive. The edge's not-found page is one ~1.6 KB single-quoted token. */
function withoutQuotedValues(body: string): string {
  return body.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
}

const SERVING_DIRECTIVE_RE =
  /(?:^|[;{}\s])(?:proxy_pass|root|alias|fastcgi_pass|uwsgi_pass|scgi_pass|grpc_pass)\s/;

/**
 * Does this location serve anything — proxy to a backend, or map a URI onto the
 * filesystem? A `return`-only location does not: it carries no route to migrate and
 * nothing that identifies the block as a site.
 */
function servesNothing(locationBody: string): boolean {
  return !SERVING_DIRECTIVE_RE.test(withoutQuotedValues(locationBody));
}

/**
 * Is this block nothing but an HTTP→HTTPS upgrade for its OWN hostname —
 * `return 301 https://$host$request_uri` / `rewrite ^ https://$server_name…
 * permanent` / the same with the host written out literally?
 *
 * certbot writes exactly one of these per host beside the real :443 vhost, so a
 * 5-site nginx yields 5 blocks with no proxy_pass and no root. They carry NO
 * route to migrate (the TLS vhost beside them has it) and Openship's edge issues
 * that redirect itself, so they're skipped SILENTLY — warning about them reads as
 * "5 of your sites won't migrate" when every one of them did.
 *
 * A redirect to a DIFFERENT host is NOT this: that rule disappears on takeover,
 * so it still warns.
 */
function isHttpsUpgradeForSelf(body: string, names: string[]): boolean {
  const targets = [
    ...body.matchAll(/(?:^|[\s;{])return\s+30[1-8]\s+([^;]+);/g),
    ...body.matchAll(/(?:^|[\s;{])rewrite\s+\S+\s+([^;]+?)\s+permanent\s*;/g),
  ].map((m) => m[1].trim());
  if (targets.length === 0) return false;

  return targets.every((raw) => {
    if (!/^https:\/\//i.test(raw)) return false;
    // `https://$host$request_uri` and `https://self.example.com$request_uri` both
    // have no `/` before the trailing variable, so cut the authority at the first
    // `$` that isn't the host variable itself.
    const authority = raw.replace(/^https:\/\//i, "").split(/[/\s]/)[0] ?? "";
    const host = (authority.match(/^(\$[a-z_]+|[^$:]+)/i)?.[1] ?? "").replace(/:\d+$/, "");
    if (host === "$host" || host === "$server_name" || host === "$http_host") return true;
    return names.includes(host);
  });
}

/**
 * Does every `location` in this block exist only to answer a CHALLENGE?
 *
 * certbot's `--webroot` leaves blocks whose sole content is
 * `location /.well-known/acme-challenge/ { root /var/www/certbot; }` — and
 * `--webroot-path` pointed at a deliberately nonexistent dir is a known certbot
 * idiom too. Their `root` is NOT a site root: treating it as one produced a
 * static vhost for a directory with no index, which the edge answers with a 500
 * (`try_files` → `/index.html` → redirect cycle). Our edge answers ACME itself,
 * so these carry nothing to migrate.
 *
 * The same reasoning covers Openship's own edge-target challenge vhost
 * (`_oblien-challenge-<slug>.conf`): a block whose only location answers
 * `/.well-known/oblien-proxy-challenge/` is scaffolding proving we control a
 * routing target, not a site. Recognising it HERE rather than in each consumer is
 * what keeps it out of the orphan sweep, the domain-claim warning
 * (`untrackedSiteFor`) and the migrate importer at once — all three read this.
 *
 * A `return`-only sibling location does not change that answer, and the reason is
 * concrete: that challenge vhost claims a whole hostname, so it must also answer
 * `/` — without a `location /` nginx falls back to its compiled-in `root html` and
 * serves the OpenResty welcome page to anyone who visits the box by IP (#431). It
 * carries the shared not-found page for that, which serves no files and proxies
 * nowhere. Judging on what a location SERVES rather than on how many there are is
 * what lets both be true at once.
 */
const CHALLENGE_LOCATION_RE = /\.well-known\/(acme-challenge|oblien-proxy-challenge)/i;

function isAcmeWebrootOnly(body: string): boolean {
  const locations = locationBlocks(body);
  if (locations.length === 0) {
    // No locations at all — a bare `root` with nothing serving it is only ACME
    // scaffolding when the path itself says so (certbot's nonexistent webroot).
    const root = firstDirective(body, "root") ?? "";
    return /letsencrypt|acme|certbot/i.test(root);
  }
  // A challenge location must be PRESENT (otherwise a redirect-only vhost with a
  // stray `root` would qualify by having nothing that serves), and nothing beside
  // it may serve anything.
  if (!locations.some((l) => CHALLENGE_LOCATION_RE.test(l.path))) return false;
  return locations.every((l) => CHALLENGE_LOCATION_RE.test(l.path) || servesNothing(l.body));
}

/**
 * Read the curated reverse-proxy tunables back out of a `server {}` body.
 *
 * The inverse of `renderProxyOptions`, driven by the SAME `PROXY_DIRECTIVES` table,
 * so the two cannot describe different directive sets. Two results, because they
 * answer different questions:
 *
 *   `raw`   — every declared directive present in the block, verbatim. This is what
 *             the box is actually serving, and it's what the UI must show. A vhost
 *             we didn't write can legally hold `client_max_body_size 20M` or
 *             `proxy_read_timeout 1d`; rendering "not set" for a value that IS set
 *             would be a lie, and the operator would chase a limit that isn't there.
 *   `settings` — the subset that survives `sanitizeProxySettings`, i.e. what can be
 *             adopted into `routingConfig.proxy` and re-rendered unchanged.
 */
function parseProxyDirectives(body: string): {
  settings?: ProxySettings;
  raw?: Record<string, string>;
} {
  const raw: Record<string, string> = {};
  const candidate: Record<string, string | number | boolean> = {};
  for (const spec of PROXY_DIRECTIVES) {
    const found = firstDirective(body, spec.directive);
    if (found === undefined) continue;
    raw[spec.key] = found;
    const parsed = parseProxyValue(spec, found);
    if (parsed !== undefined) candidate[spec.key] = parsed;
  }
  const settings = sanitizeProxySettings(candidate);
  return {
    ...(settings ? { settings } : {}),
    ...(Object.keys(raw).length > 0 ? { raw } : {}),
  };
}

function parseServer(
  body: string,
  source: string,
  upstreams: Map<string, string>,
): { site?: ImportedSite; warnings: string[] } {
  const warnings: string[] = [];
  const names = firstDirective(body, "server_name")
    ?.split(/\s+/)
    .filter((n) => n && n !== "_" && !n.startsWith("~"))
    ?? [];

  // ssl if any `listen ... ssl` or `listen 443` (443 as a whole token — not 8443)
  const listens = [...body.matchAll(/(?:^|[;{\s])listen\s+([^;]+);/g)].map((m) => m[1]);
  const ssl = listens.some((l) => /\bssl\b/.test(l) || /\b443\b/.test(l));

  const root = firstDirective(body, "root");
  const certPath = firstDirective(body, "ssl_certificate");
  const keyPath = firstDirective(body, "ssl_certificate_key");

  // No usable server_name = the default catch-all (`server_name _;` / omitted).
  // It can't become a vhost (there's no hostname to register) and every nginx has
  // one, so it's an expected skip, not a config item the operator lost.
  if (names.length === 0) return { warnings: [] };

  // All routes for this vhost. Locations are the real source; fall back to a
  // (technically-invalid but seen-in-the-wild) server-level proxy_pass.
  const rawTargets = extractLocationProxies(body);
  if (rawTargets.length === 0) {
    const serverLevel = firstDirective(body, "proxy_pass");
    if (serverLevel) rawTargets.push({ path: "/", proxyPass: serverLevel });
  }

  const resolved: { path: string; url: string }[] = [];
  for (const t of rawTargets) {
    const r = resolveProxyTarget(t.proxyPass, upstreams);
    if ("reason" in r) warnings.push(`nginx: ${names[0]} ${t.path} — ${r.reason} (skipped)`);
    else resolved.push({ path: t.path, url: r.url });
  }

  let target: ImportedSite["target"];
  let routes: { path: string; url: string }[] | undefined;
  if (resolved.length > 0) {
    // Primary = the root location ("/") if present, else the first resolved.
    // `routes` carries the FULL per-path set so a path-fan-out vhost (e.g.
    // `/ → :1010`, `/v3 → :1020`) is preserved — the edge can path-route it.
    const primary = resolved.find((r) => r.path === "/") ?? resolved[0];
    target = { kind: "proxy", url: primary.url };
    routes = resolved;
  } else if (isHttpsUpgradeForSelf(body, names)) {
    // BEFORE the `root` fallback, deliberately. certbot's :80 half usually
    // carries BOTH a redirect and an ACME webroot `root`, so checking `root`
    // first classified it as a STATIC SITE — which then collided with the real
    // :443 vhost for the same hostname downstream (one file per host) and
    // overwrote it. The site vanished and its TLS with it: the host answered
    // only on :80 serving an empty webroot.
    return { warnings: [] };
  } else if (root && !isAcmeWebrootOnly(body)) {
    target = { kind: "static", root: root.replace(/;$/, "") };
  } else if (root) {
    // A root that exists ONLY to answer /.well-known/acme-challenge — certbot
    // scaffolding, not a site. Our edge answers ACME itself (nginx.conf proxies
    // the challenge to certbot's loopback port), so there's nothing to carry.
    return { warnings: [] };
  } else {
    warnings.push(`nginx: ${names[0]} has neither proxy_pass nor root — skipped (${source})`);
    return { warnings };
  }

  const site: ImportedSite = { serverNames: names, ssl, target, source };
  if (routes) site.routes = routes;
  if (certPath && keyPath) site.tls = { certPath, keyPath };
  const tunables = parseProxyDirectives(body);
  if (tunables.settings) site.proxy = tunables.settings;
  if (tunables.raw) site.proxyRaw = tunables.raw;
  return { site, warnings };
}

/** Parse a raw nginx config string into normalized sites. Shared by `scanNginx`
 *  (foreign `/etc/nginx`) and `scanOpenshipEdge` (our OpenResty sites tree). */
function parseNginxConfig(raw: string): ProxyScanResult {
  const warnings: string[] = [];
  const sites: ImportedSite[] = [];

  if (!raw.trim()) {
    return { proxy: "nginx", sites, warnings: ["nginx: no readable configuration found"] };
  }

  // `nginx -T` prefixes each file with `# configuration file <path>:` — track it
  // for traceability; strip comments before brace-matching.
  const config = stripComments(raw);
  const upstreams = parseUpstreams(config);
  const blocks = extractBlocks(config, "server");
  if (blocks.length === 0) {
    warnings.push("nginx: no server blocks found");
  }

  for (const body of blocks) {
    const { site, warnings: blockWarnings } = parseServer(body, "nginx", upstreams);
    warnings.push(...blockWarnings);
    if (site) sites.push(site);
  }

  const { kept } = collapseByHost(
    sites,
    (s) => s.serverNames,
    (s) => (s.ssl ? 2 : 0) + (s.target.kind === "proxy" ? 1 : 0),
  );
  return { proxy: "nginx", sites: kept, warnings };
}

/**
 * One vhost file per hostname downstream, so two parsed blocks sharing a
 * `server_name` are a COLLISION — last write wins and the loser is gone. Decide
 * the winner here instead of letting file-write order decide it.
 *
 * Precedence: TLS beats plain HTTP, and a proxy beats a static root. That's the
 * certbot pair (`:80` helper + `:443` real site) resolved the right way round —
 * previously the `:80` half could overwrite the real site, leaving the host
 * answering only on port 80 with an empty webroot.
 */
export async function scanNginx(executor: CommandExecutor): Promise<ProxyScanResult> {
  return parseNginxConfig(await loadNginxConfig(executor));
}

/**
 * Every place our own edge's vhosts can sit: the canonical bind-mounted host dir
 * (containerized edge), and the two bare-host OpenResty layouts.
 */
const OUR_EDGE_SITE_GLOBS = [
  `${EDGE_HOST_PATHS.sitesDir}/*.conf`,
  `${OPENRESTY_DEFAULT_PATHS.sitesDir}/*.conf`,
  "/etc/openresty/sites-enabled/*.conf",
];

/**
 * Scan OUR OWN OpenResty edge's per-domain `server{}` blocks. NginxProvider
 * writes them to the OpenResty sites-enabled tree (NOT `/etc/nginx`, and the
 * binary is `openresty` so `nginx -T` doesn't apply), so this is how migrate
 * surfaces routes Openship itself already serves (edge classification "ours").
 * The blocks are plain nginx (`server_name` + `proxy_pass http://host:<port>` +
 * `ssl_certificate`), so the same parser applies. Read-only; empty if unreadable.
 */
/**
 * Scan a FOREIGN host OpenResty holding — or having held — the edge ports: a legacy
 * bare Openship edge, or a hand-rolled one.
 *
 * Unlike {@link scanOpenshipEdge} (which reads OUR edge's KNOWN site trees), this
 * can't assume where the vhosts live, so it dumps the fully-resolved config
 * (`openresty -T`) — the one read that follows every `include` regardless of layout,
 * and that works even after a takeover has stopped the proxy. That gap is exactly
 * what hid a legacy bare edge's sites from the migrate offer: the fixed-glob read
 * missed vhosts `include`d from a non-default path, so the scan returned zero and the
 * consent gate collapsed to takeover-only — silently dropping every site the box was
 * serving. Falls back to the known openship site trees when no `openresty` binary is
 * on PATH to dump.
 *
 * NOT folded into `scanOpenshipEdge`: a bare `openresty` binary left behind after a
 * bare→container conversion would make `-T` dump the ORPHANED bare config over the
 * container's own sites on the "ours" read path.
 */
export async function scanForeignOpenResty(
  executor: CommandExecutor,
): Promise<ProxyScanResult> {
  const dump = await dumpResolvedConfig(executor, ["openresty"]);
  if (dump) return parseNginxConfig(dump);
  return scanOpenshipEdge(executor);
}

export async function scanOpenshipEdge(executor: CommandExecutor): Promise<ProxyScanResult> {
  const cat = `cat ${OUR_EDGE_SITE_GLOBS.join(" ")} 2>/dev/null`;
  const raw = await tryExec(executor, cat);
  if (raw?.trim()) return parseNginxConfig(raw);

  // Nothing on the host. On a legacy install the sites tree is a Docker-managed
  // named volume mounted ONLY into the edge + api containers, so the host paths
  // above genuinely don't exist and the read above is indistinguishable from "no
  // sites" — which is exactly how the migrate wizard silently lost every domain
  // and cert it used to pre-fill. Ask the container directly.
  const container = await resolveOurEdgeContainer(executor);
  if (!container) return parseNginxConfig("");
  const fromContainer = await tryExec(executor, containerCommand(container, cat));
  return parseNginxConfig(fromContainer ?? "");
}
