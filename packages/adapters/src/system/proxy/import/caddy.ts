/**
 * Parse Caddy config into normalized ImportedSites.
 *
 * Prefers `caddy adapt` — Caddy's own Caddyfile→JSON adapter, which resolves
 * `import` snippets, matchers and global options into the canonical effective
 * config (the exact JSON Caddy itself runs). Falls back to a text scan of the
 * Caddyfile when the `caddy` binary / adapt output isn't available. Caddy
 * auto-provisions HTTPS for named hosts, so a site is TLS unless its address is
 * explicitly `http://` or `:80`.
 */

import type { CommandExecutor } from "../../../types";
import type { ImportedSite, ProxyScanResult } from "../../types";
import { collapseByHost, stripComments, tryExec } from "./parse-utils";

const CADDYFILE_PATHS = ["/etc/caddy/Caddyfile", "/etc/Caddyfile"];

/* ── Canonical path: `caddy adapt` → JSON ─────────────────────────────────── */

interface CaddyHandler {
  handler?: string;
  upstreams?: Array<{ dial?: string }>;
  root?: string;
  /** `php_fastcgi` adapts to a reverse_proxy whose transport is fastcgi — NOT an
   *  HTTP upstream. Migrating it as one yields a vhost where every request fails. */
  transport?: { protocol?: string };
  routes?: CaddyRoute[]; // subroute
}
interface CaddyRoute {
  match?: Array<{ host?: string[]; path?: string[] }>;
  handle?: CaddyHandler[];
}
interface CaddyAdaptConfig {
  apps?: { http?: { servers?: Record<string, { listen?: string[]; routes?: CaddyRoute[] }> } };
}

/**
 * Query Caddy's admin API for the full RUNNING config as JSON.
 *
 * This is caddy's analogue of `openresty -T`: it reports the config the server is
 * ACTUALLY running, wherever it came from — a Caddyfile at a non-default path, an
 * `import`ed snippet tree, an env-driven config, or one pushed over the API with no
 * file on disk at all. The `caddy adapt` read below only knows two fixed Caddyfile
 * paths, so every one of those layouts scanned as empty (the same fixed-path
 * fragility the openresty scan had to abandon). The admin endpoint sees them all
 * because it reads the live server, and returns the same JSON shape `parseCaddyJson`
 * already handles. Default admin address is localhost:2019.
 */
async function loadCaddyAdminConfig(executor: CommandExecutor): Promise<string | null> {
  const endpoint = "http://localhost:2019/config/";
  const out =
    (await tryExec(executor, `curl -fsS ${endpoint} 2>/dev/null`)) ||
    (await tryExec(executor, `wget -qO- ${endpoint} 2>/dev/null`));
  return out && out.trim().startsWith("{") ? out : null;
}

/** Run `caddy adapt` for the first Caddyfile that yields JSON (starts with `{`). */
async function loadCaddyJson(executor: CommandExecutor): Promise<string | null> {
  for (const p of CADDYFILE_PATHS) {
    const out = await tryExec(executor, `caddy adapt --adapter caddyfile --config ${p} 2>/dev/null`);
    if (out && out.trim().startsWith("{")) return out;
  }
  return null;
}

interface FlatHandler {
  h: CaddyHandler;
  /** The nested route this handler came from had its OWN matcher (a path, a file
   *  test…), so it serves a SUBSET of the host — not the site's main upstream. */
  scoped: boolean;
}

/**
 * Flatten a route's handlers, descending into `subroute` routes, to leaf handlers.
 *
 * Carries each nested route's matcher down as `scoped`, which is load-bearing:
 * flattening it away made a `handle_path /api/*` proxy indistinguishable from the
 * site's catch-all, and since it comes FIRST in adapt output, `find()` picked it —
 * silently routing an entire host to its /api backend. Caught against real
 * `caddy adapt` output, not a fixture.
 */
function flattenHandlers(
  handlers: CaddyHandler[] | undefined,
  scoped = false,
  out: FlatHandler[] = [],
): FlatHandler[] {
  for (const h of handlers ?? []) {
    if (h.handler === "subroute") {
      for (const r of h.routes ?? []) {
        flattenHandlers(r.handle, scoped || (r.match?.length ?? 0) > 0, out);
      }
    } else {
      out.push({ h, scoped });
    }
  }
  return out;
}

/** Handlers that mean "this route serves something we cannot express as one
 *  upstream or docroot" — worth NAMING, because silently skipping them is how a
 *  live PHP or `respond` site disappears from a migration without a word. */
const UNMIGRATABLE_HANDLERS: Record<string, string> = {
  php_fastcgi: "a PHP-FPM site (php_fastcgi)",
  fastcgi: "a FastCGI backend",
  static_response: "a static inline response (respond)",
  templates: "Caddy templates",
  encode: "",
  headers: "",
  authentication: "Caddy authentication",
  rewrite: "",
  acme_server: "an embedded ACME server",
};

interface RouteOutcome {
  target?: ImportedSite["target"];
  /** Set when the route carries something worth telling the operator about. */
  note?: string;
  /** More than one upstream — load balancing we can't reproduce with one target. */
  extraUpstreams?: number;
  /** The only upstream found was path-scoped, so using it as the host's upstream
   *  is a guess the operator must check. */
  pathScopedOnly?: boolean;
  /** Some OTHER upstream on this host is path-scoped — those path rules don't survive. */
  hasScopedSibling?: boolean;
}

/** A route's target: reverse_proxy upstream (first dial) or file_server + vars.root. */
function targetFromRoute(route: CaddyRoute): RouteOutcome {
  const flat = flattenHandlers(route.handle);
  const proxies = flat.filter((f) => f.h.handler === "reverse_proxy");
  // The CATCH-ALL proxy is the site's upstream; a path-scoped one only serves its
  // own prefix. Prefer unscoped, and say so when only a scoped one exists.
  const chosen = proxies.find((f) => !f.scoped) ?? proxies[0];
  const proxy = chosen?.h;
  if (proxy?.transport?.protocol === "fastcgi") {
    return { note: "serves a PHP-FPM/FastCGI site (php_fastcgi) — not an HTTP upstream" };
  }
  const pathScopedOnly = Boolean(chosen?.scoped);
  const hasScopedSibling = proxies.some((f) => f.scoped);
  const dials = (proxy?.upstreams ?? []).map((u) => u.dial).filter((d): d is string => Boolean(d));
  if (dials.length > 0) {
    const dial = dials[0];
    // A unix-socket upstream isn't an http URL; emitting `http://unix//run/x.sock`
    // produces a vhost that can never connect.
    if (/^unix\//i.test(dial)) {
      return { note: `proxies to the unix socket "${dial}", which needs a manual upstream` };
    }
    return {
      target: { kind: "proxy", url: /^https?:\/\//.test(dial) ? dial : `http://${dial}` },
      extraUpstreams: dials.length - 1,
      pathScopedOnly,
      hasScopedSibling,
    };
  }
  const root = flat.find((f) => f.h.handler === "vars" && typeof f.h.root === "string")?.h.root;
  if (root && flat.some((f) => f.h.handler === "file_server")) {
    return { target: { kind: "static", root } };
  }

  // Nothing we can serve. Say WHICH handler, when we recognise it.
  for (const { h } of flat) {
    const label = h.handler ? UNMIGRATABLE_HANDLERS[h.handler] : undefined;
    if (label) return { note: `serves ${label}` };
  }
  // A bare `static_response`/`redir` route is Caddy's own auto HTTP→HTTPS half —
  // the edge does that itself, so it is genuinely nothing to migrate.
  return {};
}

/** Parse `caddy adapt` JSON. Returns null when it isn't the expected shape. */
function parseCaddyJson(raw: string): { sites: ImportedSite[]; warnings: string[] } | null {
  let cfg: CaddyAdaptConfig;
  try {
    cfg = JSON.parse(raw) as CaddyAdaptConfig;
  } catch {
    return null;
  }
  const servers = cfg.apps?.http?.servers;
  if (!servers) return null;

  const sites: ImportedSite[] = [];
  const warnings: string[] = [];
  for (const srv of Object.values(servers)) {
    // TLS iff this server listens on :443 (Caddy puts the real routes there; the
    // separate :80 server only carries the auto HTTP→HTTPS redirect).
    const ssl = (srv.listen ?? []).some((l) => l.endsWith(":443"));
    for (const route of srv.routes ?? []) {
      const hosts = (route.match ?? []).flatMap((m) => m.host ?? []).filter((h) => h && h !== "*");
      if (hosts.length === 0) continue; // catch-all / no host matcher
      const outcome = targetFromRoute(route);
      if (outcome.note) {
        warnings.push(`caddy: ${hosts.join(", ")} ${outcome.note} — re-add it manually`);
        continue;
      }
      if (!outcome.target) continue; // auto HTTP→HTTPS half — the edge does that itself
      if (outcome.extraUpstreams) {
        warnings.push(
          `caddy: ${hosts.join(", ")} load-balances across ${outcome.extraUpstreams + 1} upstreams — only the first is migrated`,
        );
      }
      // Path routing doesn't survive a single-upstream vhost. Two flavours, and
      // the second is a guess worth flagging harder than the first.
      if (outcome.hasScopedSibling || (route.match ?? []).some((m) => m.path?.length)) {
        warnings.push(
          `caddy: ${hosts.join(", ")} routes some paths to other upstreams — only the catch-all is migrated; re-add path rules manually`,
        );
      }
      if (outcome.pathScopedOnly) {
        warnings.push(
          `caddy: ${hosts.join(", ")} has no catch-all upstream — used its path-scoped one; verify the target`,
        );
      }
      // Certs: Caddy auto-provisions, and openship re-issues via Let's Encrypt on
      // takeover, so we carry only the ssl flag here (no fragile cert→SNI mapping).
      sites.push({ serverNames: hosts, ssl, target: outcome.target, source: "caddy (adapt)" });
    }
  }
  // An `http://host` block and the auto-HTTPS one for the same host both carry a
  // real handler — TLS must win, or the site comes back plain HTTP.
  const { kept, dropped } = collapseByHost(
    sites,
    (s) => s.serverNames,
    (s) => (s.ssl ? 1 : 0),
  );
  for (const d of dropped) {
    warnings.push(
      `caddy: ${d.serverNames.join(", ")} had a second (non-TLS) block — kept the TLS one`,
    );
  }
  return { sites: kept, warnings };
}

async function loadCaddyfile(executor: CommandExecutor): Promise<string> {
  for (const p of CADDYFILE_PATHS) {
    const out = await tryExec(executor, `cat ${p} 2>/dev/null`);
    if (out && out.trim()) return out;
  }
  return "";
}

/** Split a Caddyfile into { header, body } blocks with balanced braces. */
function caddyBlocks(text: string): Array<{ header: string; body: string }> {
  const out: Array<{ header: string; body: string }> = [];
  let i = 0;
  let headerStart = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const header = text.slice(headerStart, i).trim();
      let depth = 1;
      let j = i + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      if (depth !== 0) break; // unbalanced
      out.push({ header, body: text.slice(i + 1, j - 1) });
      i = j;
      headerStart = j;
    } else {
      i++;
    }
  }
  return out;
}

/** example.com, https://www.example.com:443 → { host, ssl } entries. */
function parseAddresses(header: string): Array<{ host: string; ssl: boolean }> {
  return header
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((addr) => {
      const httpScheme = /^http:\/\//i.test(addr);
      const host = addr.replace(/^https?:\/\//i, "").replace(/:\d+$/, "");
      const isPort80 = /:80$/.test(addr);
      return { host, ssl: !httpScheme && !isPort80 };
    })
    .filter((a) => a.host && !a.host.startsWith(":") && a.host !== "*");
}

/**
 * Scan Caddy config → sites. Tries `caddy adapt` (canonical JSON) first, falling
 * back to the Caddyfile text scan when adapt is unavailable or yields nothing.
 */
export async function scanCaddy(executor: CommandExecutor): Promise<ProxyScanResult> {
  // Live admin API first, then fixed-path `caddy adapt`. Both yield the same JSON
  // shape; the admin endpoint additionally sees configs adapt's two fixed paths
  // can't (non-default Caddyfile, imported snippets, an API-pushed config with no
  // file) — the fixed-path fragility the openresty scan had to move off of.
  for (const load of [loadCaddyAdminConfig, loadCaddyJson]) {
    const json = await load(executor);
    if (!json) continue;
    const parsed = parseCaddyJson(json);
    // Sites OR warnings means it gave a real answer. Requiring sites > 0 meant a
    // config we deliberately REFUSED (all php_fastcgi, all unix sockets) looked
    // like "found nothing", fell through to the text scan, and threw the refusal
    // reasons away — the operator got "no readable Caddyfile" instead.
    if (parsed && (parsed.sites.length > 0 || parsed.warnings.length > 0)) {
      return { proxy: "caddy", sites: parsed.sites, warnings: parsed.warnings };
    }
  }
  return scanCaddyText(executor);
}

/* ── Fallback path: text scan of the raw Caddyfile ────────────────────────── */

async function scanCaddyText(executor: CommandExecutor): Promise<ProxyScanResult> {
  const raw = await loadCaddyfile(executor);
  const warnings: string[] = [];
  const sites: ImportedSite[] = [];

  if (!raw.trim()) {
    return { proxy: "caddy", sites, warnings: ["caddy: no readable Caddyfile found"] };
  }

  const text = stripComments(raw);
  let blocks = caddyBlocks(text);

  // Brace-less single-site shorthand ("example.com\n reverse_proxy …") has no
  // `{ }` — synthesize one block from the first non-empty line (address) + rest,
  // so the common single-site Caddyfile is migrated instead of silently dropped.
  if (blocks.length === 0) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      blocks = [{ header: lines[0], body: lines.slice(1).join("\n") }];
    } else {
      warnings.push("caddy: config present but no parseable site blocks");
    }
  }

  for (const { header, body } of blocks) {
    if (!header) continue; // global options block

    const addrs = parseAddresses(header);
    if (addrs.length === 0) {
      warnings.push(`caddy: skipped a block with no usable address (${header.slice(0, 40)})`);
      continue;
    }

    const inlineProxy = body.match(/(?:^|\s)reverse_proxy\s+([^\n{]+)/);
    // Block form — `reverse_proxy {\n  to backend:8080\n  header_up …\n}` — is
    // idiomatic Caddy and has NO inline upstream, so the inline regex above missed
    // it entirely and the site was reported as having no reverse_proxy at all.
    const blockProxy = body.match(/(?:^|\s)reverse_proxy\s*\{([\s\S]*?)\}/);
    const blockTo = blockProxy?.[1].match(/(?:^|\n)\s*to\s+([^\n]+)/);
    const rootMatch = body.match(/(?:^|\s)root\s+\*?\s*([^\n\s]+)/);
    const tlsMatch = body.match(/(?:^|\s)tls\s+(\S+)\s+(\S+)/); // tls <cert> <key>

    const upstreams = (inlineProxy?.[1] ?? blockTo?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const host = addrs[0].host;

    let target: ImportedSite["target"];
    if (upstreams.length > 0) {
      const upstream = upstreams[0];
      if (/^unix\//i.test(upstream)) {
        warnings.push(
          `caddy: ${host} proxies to the unix socket "${upstream}" — needs a manual upstream, skipped`,
        );
        continue;
      }
      if (upstreams.length > 1) {
        warnings.push(
          `caddy: ${host} load-balances across ${upstreams.length} upstreams — only the first is migrated`,
        );
      }
      target = { kind: "proxy", url: /^https?:\/\//.test(upstream) ? upstream : `http://${upstream}` };
    } else if (/(?:^|\s)php_fastcgi\s/.test(body)) {
      // BEFORE `root`, and that order is a SECURITY property: `root * /srv/php` +
      // `php_fastcgi` is the standard PHP site, and migrating it as a static root
      // serves .php files as plain text — source disclosure, not just a 500.
      warnings.push(
        `caddy: ${host} serves a PHP-FPM site (php_fastcgi) — not migratable as a static root; re-add it manually`,
      );
      continue;
    } else if (rootMatch) {
      target = { kind: "static", root: rootMatch[1] };
    } else {
      warnings.push(`caddy: ${host} has no reverse_proxy or root — skipped`);
      continue;
    }
    // A path-scoped handler means the upstream we found serves only part of the
    // site; taking it as the whole host quietly rewires everything else.
    if (/(?:^|\s)(handle_path|handle)\s+\//.test(body)) {
      warnings.push(
        `caddy: ${host} routes by path (handle/handle_path) — only one upstream is migrated; re-add path rules manually`,
      );
    }

    const site: ImportedSite = {
      serverNames: addrs.map((a) => a.host),
      ssl: addrs.some((a) => a.ssl),
      target,
      source: "caddy",
    };
    if (tlsMatch && tlsMatch[1].includes("/")) {
      site.tls = { certPath: tlsMatch[1], keyPath: tlsMatch[2] };
    }
    sites.push(site);
  }

  const { kept, dropped } = collapseByHost(
    sites,
    (s) => s.serverNames,
    (s) => (s.ssl ? 1 : 0),
  );
  for (const d of dropped) {
    warnings.push(
      `caddy: ${d.serverNames.join(", ")} had a second (non-TLS) block — kept the TLS one`,
    );
  }

  return { proxy: "caddy", sites: kept, warnings };
}
