/**
 * Parse Apache httpd virtual hosts into normalized ImportedSites.
 *
 * Prefers `apachectl -S` (a.k.a. DUMP_VHOSTS) to enumerate the EFFECTIVE vhost
 * files — that resolves arbitrary `Include`/`IncludeOptional` directives and
 * finds vhosts in non-standard locations — then parses those files. Falls back
 * to catting the conventional sites-enabled / conf.d locations (Debian + RHEL).
 * Parses `<VirtualHost>` blocks: ServerName/ServerAlias, ProxyPass, DocumentRoot,
 * SSL cert paths. Best-effort; unparseable vhosts become warnings.
 */

import type { CommandExecutor } from "../../../types";
import type { ImportedSite, ProxyScanResult } from "../../types";
import { collapseByHost, sq, stripComments, tryExec } from "./parse-utils";

/** Files `apachectl -S` reports as holding vhost defs (Include-resolved). */
async function vhostFilesFromDump(executor: CommandExecutor): Promise<string[]> {
  const dump = await tryExec(
    executor,
    "apachectl -S 2>/dev/null || apache2ctl -S 2>/dev/null || httpd -S 2>/dev/null",
  );
  if (!dump) return [];
  // Each vhost line ends with `(</path/to/file>:<line>)`.
  const files = new Set<string>();
  for (const m of dump.matchAll(/\(([^()]+?):\d+\)/g)) {
    const f = m[1].trim();
    if (f.startsWith("/")) files.add(f);
  }
  return [...files];
}

async function loadApacheConfig(executor: CommandExecutor): Promise<string> {
  // Effective vhost files first (Include-resolved), then the conventional cat.
  const files = await vhostFilesFromDump(executor);
  if (files.length > 0) {
    const cat = await tryExec(executor, `cat ${files.map(sq).join(" ")} 2>/dev/null`);
    if (cat && cat.trim()) return cat;
  }
  const cat = await tryExec(
    executor,
    "cat /etc/apache2/sites-enabled/*.conf /etc/apache2/apache2.conf " +
      "/etc/httpd/conf.d/*.conf /etc/httpd/conf/httpd.conf 2>/dev/null",
  );
  return cat ?? "";
}

/** Drop the `"`/`'` httpd reads as argument delimiters (`DocumentRoot "/srv/x"`). */
function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** The single argument of a one-argument directive, unquoted. */
function directive(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|\\n)\\s*${name}\\s+([^\\n]+)`, "i"));
  const value = m?.[1]?.trim();
  return value === undefined ? undefined : unquote(value);
}

/** All values of a directive that may appear on multiple lines (e.g. ServerAlias). */
function directiveAll(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`(?:^|\\n)\\s*${name}\\s+([^\\n]+)`, "gi"))].map((m) =>
    m[1].trim(),
  );
}

/**
 * Is this vhost nothing but an HTTP→HTTPS upgrade for its own hostname?
 *
 * Apache writes this two ways — `Redirect permanent / https://…` and a
 * `RewriteRule … [R=301]` — and such a vhost very often ALSO carries a
 * DocumentRoot, so it parsed as a real static site and then collided with the
 * `:443` vhost for the same ServerName. That collision is how a live HTTPS site
 * came back as an empty docroot. Openship's edge issues that redirect itself, so
 * there is nothing here to carry.
 */
function isHttpsRedirectOnly(body: string): boolean {
  const hasProxy = /(?:^|\n)\s*ProxyPass\s+\S+\s+(?!!)\S/i.test(body);
  if (hasProxy) return false;
  const redirects = [
    ...body.matchAll(/(?:^|\n)\s*Redirect(?:Permanent|Match)?\s+(?:\d{3}\s+|permanent\s+|temp\s+)?\S*\s*(\S+)/gi),
    ...body.matchAll(/(?:^|\n)\s*RewriteRule\s+\S+\s+(\S+)\s*\[[^\]]*R=?3\d\d[^\]]*\]/gi),
  ].map((m) => m[1]);
  return redirects.length > 0 && redirects.some((t) => /^https:\/\//i.test(t));
}

/** `ServerName example.com:443` is valid Apache — the port is NOT part of the
 *  hostname, and carrying it through produced `server_name example.com:443`,
 *  which matches nothing. */
function hostOnly(name: string): string {
  return unquote(name.trim())
    .replace(/^https?:\/\//i, "")
    .replace(/:\d+$/, "");
}

/**
 * Every `ProxyPass` mapping in a vhost, as `<path> → <upstream>`.
 *
 * Read line by line so a mapping can't run past its own line, and both documented
 * argument forms are accepted: `ProxyPass <path> <url>` at vhost level, and the
 * one-argument `ProxyPass <url>` whose path is the enclosing `<Location>`. A
 * `<LocationMatch>` path is a regex no single prefix can express, so its mappings
 * are dropped and reported through `regexScoped` instead.
 */
function proxyRoutes(body: string): {
  routes: Array<{ path: string; url: string }>;
  regexScoped: boolean;
} {
  const routes: Array<{ path: string; url: string }> = [];
  const scopes: Array<{ path: string | null; regex: boolean }> = [];
  let regexScoped = false;
  for (const line of body.split("\n")) {
    const open = line.match(/^\s*<Location(Match)?\s+([^>]*)>/i);
    if (open) {
      const regex = Boolean(open[1]);
      const arg = unquote(open[2].trim());
      scopes.push({ path: !regex && arg.startsWith("/") ? arg : null, regex });
      continue;
    }
    if (/^\s*<\/Location(?:Match)?\s*>/i.test(line)) {
      scopes.pop();
      continue;
    }
    const m = line.match(/^\s*ProxyPass\s+(\S+)(?:\s+(\S+))?/i);
    if (!m) continue;
    const first = unquote(m[1]);
    if (first.startsWith("/")) {
      routes.push({ path: first, url: m[2] ? unquote(m[2]) : "" });
      continue;
    }
    // The one-argument form is only legal inside a <Location>, which is the only
    // place a path for it exists.
    const scope = scopes[scopes.length - 1];
    if (scope?.path) routes.push({ path: scope.path, url: first });
    else if (scope?.regex) regexScoped = true;
  }
  return { routes, regexScoped };
}

function parseVhost(body: string, portHint: string): ImportedSite | { warning: string } | null {
  const serverName = directive(body, "ServerName")?.split(/\s+/)[0];
  const aliases = directiveAll(body, "ServerAlias").flatMap((line) => line.split(/\s+/));
  const names = [serverName, ...aliases]
    .filter((n): n is string => Boolean(n))
    .map(hostOnly)
    .filter(Boolean);

  if (names.length === 0) {
    return { warning: "apache: skipped a VirtualHost with no ServerName" };
  }

  // Checked BEFORE DocumentRoot: a redirect vhost with a docroot is still a
  // redirect vhost, and treating it as a static site is what lost the real one.
  if (isHttpsRedirectOnly(body)) return null;

  // ProxyPass <path> http://upstream — keep ALL non-"!" mappings (path fan-out);
  // primary = the "/" mapping if present, else the first.
  const proxy = proxyRoutes(body);
  const routes = proxy.routes.filter((p) => p.url && p.url !== "!");
  const docRoot = directive(body, "DocumentRoot");
  // `ProxyPassMatch … fcgi://` / `…php-fpm.sock` — a PHP application, whatever its
  // DocumentRoot says.
  const fcgiMatch = /(?:^|\n)\s*ProxyPassMatch\s+[^\n]*(fcgi:|php-fpm|php\d*-fpm|\.sock)/i.test(body);
  const certPath = directive(body, "SSLCertificateFile");
  const keyPath = directive(body, "SSLCertificateKeyFile");
  const ssl = /:443/.test(portHint) || /SSLEngine\s+on/i.test(body) || Boolean(certPath);

  let target: ImportedSite["target"];
  if (routes.length > 0) {
    const primary = routes.find((r) => r.path === "/") ?? routes[0];
    // `balancer://cluster/` needs the matching <Proxy balancer://…> member list,
    // which no single upstream can express — emitting it yields a vhost nginx
    // can't resolve.
    if (/^balancer:\/\//i.test(primary.url)) {
      return {
        warning: `apache: ${names[0]} proxies to an mod_proxy_balancer cluster (${primary.url}) — re-add its members manually`,
      };
    }
    target = { kind: "proxy", url: primary.url };
  } else if (fcgiMatch) {
    // Checked BEFORE DocumentRoot, and that order is a SECURITY property: the
    // canonical PHP-FPM vhost is `DocumentRoot` + `ProxyPassMatch … fcgi://`, so
    // treating it as static would serve .php files as plain text — source
    // disclosure (credentials in config.php), not merely a broken site.
    return {
      warning: `apache: ${names[0]} is a PHP-FPM site (ProxyPassMatch → FastCGI) — not migratable as a static root; re-add it manually`,
    };
  } else if (docRoot) {
    target = { kind: "static", root: docRoot };
  } else if (/(?:^|\n)\s*ProxyPassMatch\s/i.test(body)) {
    // Regex-keyed proxying with no docroot has no single upstream either.
    return {
      warning: `apache: ${names[0]} uses ProxyPassMatch (regex proxying) — re-add it manually`,
    };
  } else if (proxy.regexScoped) {
    return {
      warning: `apache: ${names[0]} proxies from inside a <LocationMatch> (regex proxying) — re-add it manually`,
    };
  } else {
    return { warning: `apache: ${names[0]} has neither ProxyPass nor DocumentRoot — skipped` };
  }

  const site: ImportedSite = { serverNames: names, ssl, target, source: "apache" };
  if (routes.length > 0) site.routes = routes;
  if (certPath && keyPath) site.tls = { certPath, keyPath };
  return site;
}

/** ServerName + aliases of a vhost we're about to drop as a redirect half. */
function redirectVhostNames(body: string): string[] {
  const serverName = directive(body, "ServerName")?.split(/\s+/)[0];
  const aliases = directiveAll(body, "ServerAlias").flatMap((l) => l.split(/\s+/));
  return [serverName, ...aliases].filter((n): n is string => Boolean(n)).map(hostOnly).filter(Boolean);
}

/** Extract `<VirtualHost x>…</VirtualHost>` bodies + the opening-tag args. */
function vhostBlocks(text: string): Array<{ args: string; body: string }> {
  const out: Array<{ args: string; body: string }> = [];
  const re = /<VirtualHost([^>]*)>([\s\S]*?)<\/VirtualHost>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ args: m[1].trim(), body: m[2] });
  }
  return out;
}

export async function scanApache(executor: CommandExecutor): Promise<ProxyScanResult> {
  const raw = await loadApacheConfig(executor);
  const warnings: string[] = [];
  const sites: ImportedSite[] = [];

  if (!raw.trim()) {
    return { proxy: "apache", sites, warnings: ["apache: no readable configuration found"] };
  }

  const text = stripComments(raw);
  const blocks = vhostBlocks(text);
  if (blocks.length === 0) warnings.push("apache: no <VirtualHost> blocks found");

  /** Hostnames whose only vhost was an HTTP→HTTPS redirect. */
  const redirectOnlyHosts: string[][] = [];
  for (const { args, body } of blocks) {
    const parsed = parseVhost(body, args);
    if (parsed === null) {
      redirectOnlyHosts.push(redirectVhostNames(body));
      continue; // HTTP→HTTPS redirect half — the edge does that itself
    }
    if ("warning" in parsed) warnings.push(parsed.warning);
    else sites.push(parsed);
  }

  // Dropping the redirect half is right when the TLS vhost beside it carries the
  // site. When there ISN'T one, the hostname would vanish without a word — so say
  // it, rather than letting the operator discover a missing domain in production.
  const served = new Set(sites.flatMap((s) => s.serverNames));
  for (const names of redirectOnlyHosts) {
    const orphaned = names.filter((n) => !served.has(n));
    if (orphaned.length > 0) {
      warnings.push(
        `apache: ${orphaned.join(", ")} only redirected to HTTPS and has no TLS VirtualHost here — nothing to serve it after migration`,
      );
    }
  }

  // `<VirtualHost *:80>` and `<VirtualHost *:443>` for the same ServerName both
  // reach here when the :80 half serves real content; TLS has to win.
  const { kept, dropped } = collapseByHost(
    sites,
    (s) => s.serverNames,
    (s) => (s.ssl ? 2 : 0) + (s.target.kind === "proxy" ? 1 : 0),
  );
  for (const d of dropped) {
    warnings.push(
      `apache: ${d.serverNames.join(", ")} had a second VirtualHost (${d.ssl ? "TLS" : "plain HTTP"}, ${d.target.kind}) — kept the TLS/proxy one`,
    );
  }

  return { proxy: "apache", sites: kept, warnings };
}
