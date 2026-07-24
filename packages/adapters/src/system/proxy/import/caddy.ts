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
import { stripComments, tryExec } from "./parse-utils";

const CADDYFILE_PATHS = ["/etc/caddy/Caddyfile", "/etc/Caddyfile"];

/* ── Canonical path: `caddy adapt` → JSON ─────────────────────────────────── */

interface CaddyHandler {
  handler?: string;
  upstreams?: Array<{ dial?: string }>;
  root?: string;
  routes?: CaddyRoute[]; // subroute
}
interface CaddyRoute {
  match?: Array<{ host?: string[] }>;
  handle?: CaddyHandler[];
}
interface CaddyAdaptConfig {
  apps?: { http?: { servers?: Record<string, { listen?: string[]; routes?: CaddyRoute[] }> } };
}

/** Run `caddy adapt` for the first Caddyfile that yields JSON (starts with `{`). */
async function loadCaddyJson(executor: CommandExecutor): Promise<string | null> {
  for (const p of CADDYFILE_PATHS) {
    const out = await tryExec(executor, `caddy adapt --adapter caddyfile --config ${p} 2>/dev/null`);
    if (out && out.trim().startsWith("{")) return out;
  }
  return null;
}

/** Flatten a route's handlers, descending into `subroute` routes, to leaf handlers. */
function flattenHandlers(handlers: CaddyHandler[] | undefined, out: CaddyHandler[] = []): CaddyHandler[] {
  for (const h of handlers ?? []) {
    if (h.handler === "subroute") {
      for (const r of h.routes ?? []) flattenHandlers(r.handle, out);
    } else {
      out.push(h);
    }
  }
  return out;
}

/** A route's target: reverse_proxy upstream (first dial) or file_server + vars.root. */
function targetFromRoute(route: CaddyRoute): ImportedSite["target"] | null {
  const flat = flattenHandlers(route.handle);
  const dial = flat.find((h) => h.handler === "reverse_proxy")?.upstreams?.find((u) => u.dial)?.dial;
  if (dial) return { kind: "proxy", url: /^https?:\/\//.test(dial) ? dial : `http://${dial}` };
  const root = flat.find((h) => h.handler === "vars" && typeof h.root === "string")?.root;
  if (root && flat.some((h) => h.handler === "file_server")) return { kind: "static", root };
  return null; // redirect-only (auto HTTP→HTTPS) or an unsupported handler
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
  for (const srv of Object.values(servers)) {
    // TLS iff this server listens on :443 (Caddy puts the real routes there; the
    // separate :80 server only carries the auto HTTP→HTTPS redirect).
    const ssl = (srv.listen ?? []).some((l) => l.endsWith(":443"));
    for (const route of srv.routes ?? []) {
      const hosts = (route.match ?? []).flatMap((m) => m.host ?? []).filter((h) => h && h !== "*");
      if (hosts.length === 0) continue; // catch-all / no host matcher
      const target = targetFromRoute(route);
      if (!target) continue; // redirect-only or unsupported — nothing to migrate
      // Certs: Caddy auto-provisions, and openship re-issues via Let's Encrypt on
      // takeover, so we carry only the ssl flag here (no fragile cert→SNI mapping).
      sites.push({ serverNames: hosts, ssl, target, source: "caddy (adapt)" });
    }
  }
  return { sites, warnings: [] };
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
  const json = await loadCaddyJson(executor);
  if (json) {
    const parsed = parseCaddyJson(json);
    if (parsed && parsed.sites.length > 0) {
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

    const proxyMatch = body.match(/(?:^|\s)reverse_proxy\s+([^\n{]+)/);
    const rootMatch = body.match(/(?:^|\s)root\s+\*?\s*([^\n\s]+)/);
    const tlsMatch = body.match(/(?:^|\s)tls\s+(\S+)\s+(\S+)/); // tls <cert> <key>

    let target: ImportedSite["target"];
    if (proxyMatch) {
      const upstream = proxyMatch[1].trim().split(/\s+/)[0];
      target = { kind: "proxy", url: /^https?:\/\//.test(upstream) ? upstream : `http://${upstream}` };
    } else if (rootMatch) {
      target = { kind: "static", root: rootMatch[1] };
    } else {
      warnings.push(`caddy: ${addrs[0].host} has no reverse_proxy or root — skipped`);
      continue;
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

  return { proxy: "caddy", sites, warnings };
}
