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
import { sq, stripComments, tryExec } from "./parse-utils";

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

function directive(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|\\n)\\s*${name}\\s+([^\\n]+)`, "i"));
  return m?.[1]?.trim();
}

/** All values of a directive that may appear on multiple lines (e.g. ServerAlias). */
function directiveAll(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`(?:^|\\n)\\s*${name}\\s+([^\\n]+)`, "gi"))].map((m) =>
    m[1].trim(),
  );
}

function parseVhost(body: string, portHint: string): ImportedSite | { warning: string } {
  const serverName = directive(body, "ServerName")?.split(/\s+/)[0];
  const aliases = directiveAll(body, "ServerAlias").flatMap((line) => line.split(/\s+/));
  const names = [serverName, ...aliases].filter((n): n is string => Boolean(n));

  if (names.length === 0) {
    return { warning: "apache: skipped a VirtualHost with no ServerName" };
  }

  // ProxyPass / <path> http://upstream  (take the first non-"!" mapping)
  const proxyLine = [...body.matchAll(/(?:^|\n)\s*ProxyPass\s+(\S+)\s+(\S+)/gi)]
    .map((m) => ({ path: m[1], url: m[2] }))
    .find((p) => p.url && p.url !== "!");
  const docRoot = directive(body, "DocumentRoot")?.replace(/^["']|["']$/g, "");
  const certPath = directive(body, "SSLCertificateFile");
  const keyPath = directive(body, "SSLCertificateKeyFile");
  const ssl = /:443/.test(portHint) || /SSLEngine\s+on/i.test(body) || Boolean(certPath);

  let target: ImportedSite["target"];
  if (proxyLine) {
    target = { kind: "proxy", url: proxyLine.url };
  } else if (docRoot) {
    target = { kind: "static", root: docRoot };
  } else {
    return { warning: `apache: ${names[0]} has neither ProxyPass nor DocumentRoot — skipped` };
  }

  const site: ImportedSite = { serverNames: names, ssl, target, source: "apache" };
  if (certPath && keyPath) site.tls = { certPath, keyPath };
  return site;
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

  for (const { args, body } of blocks) {
    const parsed = parseVhost(body, args);
    if ("warning" in parsed) warnings.push(parsed.warning);
    else sites.push(parsed);
  }

  return { proxy: "apache", sites, warnings };
}
