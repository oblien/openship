/**
 * OpenResty infrastructure provider - routing + SSL for self-hosted deployments.
 *
 * Writes server block config files to a directory that OpenResty `include`s,
 * then reloads. SSL is handled by certbot (Let's Encrypt) running
 * as a separate process - OpenResty just reads the cert files.
 *
 * This provider works with BOTH Docker and Bare runtimes.
 *
 * Typical nginx.conf inside OpenResty:
 * ```
 * http {
 *   include /usr/local/openresty/nginx/conf/sites-enabled/*;
 * }
 * ```
 */

import {
  access as fsAccess,
  writeFile as fsWriteFile,
  rm as fsRm,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
} from "node:fs/promises";
import { execFile as cpExecFile } from "node:child_process";
import { randomBytes, X509Certificate, createPrivateKey } from "node:crypto";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

import type { CommandExecutor, ManualCert, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider } from "./types";
import { LUA_LOGGER_PATH, RULES_GUARD_PATH, luaSourceAvailable, buildReloadCommand, detectOpenRestyPaths, type OpenRestyPaths } from "./openresty-lua";
import { safeErrorMessage, sanitizeProxySettings, PROXY_GZIP_TYPES, type ProxySettings } from "@repo/core";
import { sq } from "../system/local-shell";

/** Reverse-proxy headers shared by every proxy_pass location. */
const PROXY_HEADERS = `proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";`;

/** Render extra path-prefix proxy locations (composite single-domain routing). */
function renderProxyLocations(route: RouteConfig): string {
  if (!route.proxyLocations || route.proxyLocations.length === 0) return "";
  return route.proxyLocations
    .map((loc) => {
      assertValidUpstream(loc.targetUrl);
      return `
    location ${loc.pathPrefix} {
        proxy_pass ${loc.targetUrl};
        ${PROXY_HEADERS}
    }`;
    })
    .join("");
}

/** Render vercel.json `redirects` as `return <code> <dest>` locations. */
function renderRedirects(route: RouteConfig): string {
  if (!route.redirects || route.redirects.length === 0) return "";
  return route.redirects
    .map(
      (r) => `
    location ${r.exact ? "= " : ""}${r.path} {
        return ${r.statusCode} ${r.destination};
    }`,
    )
    .join("");
}

/**
 * Render GLOBAL (source `/(.*)` → path `/`) header rules as server-scope
 * `add_header … always;`. Path-scoped header rules are skipped here (they'd
 * need a dedicated location that could shadow proxy/static behavior) — the
 * common case is global security headers.
 */
function renderServerHeaders(route: RouteConfig): string {
  const global = (route.headerRules ?? []).filter((rule) => rule.path === "/");
  const lines = global.flatMap((rule) =>
    rule.headers.map((h) => `    add_header ${h.key} "${h.value.replace(/"/g, '\\"')}" always;`),
  );
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/**
 * Render the curated reverse-proxy tunables (client_max_body_size, proxy/body
 * timeouts, buffering, gzip) as server-scope directives. Re-validates every
 * value via `sanitizeProxySettings` before emitting — a malformed value is
 * DROPPED, never interpolated raw into the config (defense-in-depth over the
 * API schema; keeps `nginx -t` safe). gzip emits a FIXED, safe type set.
 */
export function renderProxyOptions(proxy?: ProxySettings | null): string {
  const p = sanitizeProxySettings(proxy);
  if (!p) return "";
  const lines: string[] = [];
  if (p.clientMaxBodySize) lines.push(`    client_max_body_size ${p.clientMaxBodySize};`);
  if (p.proxyReadTimeout) lines.push(`    proxy_read_timeout ${p.proxyReadTimeout};`);
  if (p.proxySendTimeout) lines.push(`    proxy_send_timeout ${p.proxySendTimeout};`);
  if (p.clientBodyTimeout) lines.push(`    client_body_timeout ${p.clientBodyTimeout};`);
  if (p.proxyBuffering !== undefined) {
    lines.push(`    proxy_buffering ${p.proxyBuffering ? "on" : "off"};`);
  }
  if (p.gzip !== undefined) {
    lines.push(`    gzip ${p.gzip ? "on" : "off"};`);
    if (p.gzip) {
      lines.push(`    gzip_types ${PROXY_GZIP_TYPES};`);
      lines.push(`    gzip_min_length 1024;`);
    }
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

// ─── Rate Limit Config ──────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Requests per second (0 = disabled) */
  rps: number;
  /** Burst allowance (extra requests above rate, queued with nodelay) */
  burst: number;
  /** CIDR strings whitelisted from rate limiting (e.g. ["127.0.0.1/32", "10.0.0.0/8"]) */
  whitelist: string[];
}

/**
 * Render the `geo $whitelist` body for the rate-limit snippet: the loopback
 * defaults plus one `<cidr> 1;` entry per whitelisted CIDR.
 *
 * Exported for testing.
 */
export function renderGeoEntries(whitelist: readonly string[]): string[] {
  const entries = [
    "        default         0;",
    "        127.0.0.1/32    1;",
    "        ::1/128         1;",
  ];
  for (const cidr of whitelist) {
    // Validate CIDR format loosely (prevents injection)
    if (/^[\da-fA-F.:\/]+$/.test(cidr) && cidr.length <= 50) {
      // `padEnd(15)` plus an explicit space keeps the historical 16-column
      // alignment for short CIDRs, while still separating longer ones. Padding
      // to 16 with no space is a no-op once the CIDR is already >= 16 chars,
      // which emits `192.168.100.0/241;` - nginx then reads an address with no
      // value and `openresty -t` fails, rolling the whole change back.
      entries.push(`        ${cidr.padEnd(15)} 1;`);
    }
  }
  return entries;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NginxProviderOptions {
  /**
   * Detected OpenResty paths - from detectOpenRestyPaths().
   * Every path (sitesDir, confPath, bin, pid) comes from here.
   */
  paths: OpenRestyPaths;
  /**
   * ACME email for certbot certificate registration.
   */
  acmeEmail?: string;
  /**
   * Path to Let's Encrypt live certificate directory.
   * Default: /etc/letsencrypt/live
   */
  certDir?: string;
  /**
   * Command executor for file operations.
   * When provided, all ops go through the executor (SSH remote).
   * When omitted, uses node:fs directly (local).
   */
  executor?: CommandExecutor;
}

const DEFAULT_CERT_DIR = "/etc/letsencrypt/live";

/** Only allow valid domain characters - prevents shell injection. */
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function assertValidDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain) || domain.length > 253) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

/**
 * `proxy_pass`/`root` values are interpolated verbatim into the generated
 * server{} block and — on proxy adopt/takeover — come from PARSING A FOREIGN
 * proxy config (semi-trusted). Reject anything that could break out of the
 * single-token directive and inject arbitrary nginx config. `openresty -t` only
 * catches MALFORMED output, so a well-formed injection would otherwise slip in.
 * Normal deploy targets (`http://127.0.0.1:3000`, `/var/www/app`) contain none
 * of these chars, so this never rejects a legitimate route.
 */
function assertNoNginxInjection(value: string, what: string): void {
  if (/[\s;{}#\\]/.test(value)) {
    throw new Error(`Invalid ${what} (contains characters that could inject nginx config): ${value}`);
  }
}

function assertValidUpstream(targetUrl: string): void {
  assertNoNginxInjection(targetUrl, "proxy target");
  if (!/^https?:\/\/.+/.test(targetUrl)) {
    throw new Error(`Invalid proxy target (must be http/https URL): ${targetUrl}`);
  }
}

function assertValidStaticRoot(root: string): void {
  assertNoNginxInjection(root, "static root");
  if (!root.startsWith("/") || root.includes("..")) {
    throw new Error(`Invalid static root (must be an absolute path, no traversal): ${root}`);
  }
}

const execFileAsync = promisify(cpExecFile);

/**
 * Turn certbot's verbose failure output into ONE actionable line.
 *
 * certbot buries the cause in a `Type:` / `Detail:` / `Hint:` block and opens with
 * boilerplate ("Saving debug log to …") that tells the operator nothing. Pull the
 * meaningful lines and map the common HTTP-01 failure shapes to a plain-English
 * diagnosis so a failed cert says WHY — DNS, firewall/port-80, or a proxy still on
 * :80 — instead of the opaque opener.
 */
export function summarizeCertbotFailure(output: string, domain: string): string {
  const text = output || "";
  const pick = (re: RegExp) => text.match(re)?.[0]?.replace(/\s+/g, " ").trim();
  const detail = pick(/Detail:\s*[^\n]+/i);
  const hint = pick(/Hint:\s*[^\n]+/i);

  let diagnosis: string | undefined;
  if (/timeout during connect|connection refused|failed to connect|Timeout/i.test(text)) {
    diagnosis =
      `Port 80 for ${domain} isn't reachable from the internet — a firewall / cloud security group ` +
      `is blocking it, the domain doesn't point at this server, or another proxy is still bound to :80.`;
  } else if (/NXDOMAIN|no\s+(A|AAAA)\s+record|DNS problem|could not be resolved|no records? found/i.test(text)) {
    diagnosis =
      `${domain} doesn't resolve to this server yet — the DNS A record is missing or hasn't propagated. ` +
      `Wait for propagation, then retry from the Domains tab.`;
  } else if (/404|invalid response|unauthorized|"?status"?:?\s*40\d/i.test(text)) {
    diagnosis =
      `Port 80 answered but not with our ACME challenge — another web server is still serving :80, so ` +
      `the takeover didn't complete. Re-run and choose take-over / migrate.`;
  } else if (/too many certificates|rateLimited|rate limit/i.test(text)) {
    diagnosis = `Let's Encrypt rate limit reached for ${domain} — wait before retrying.`;
  }

  const parts = [diagnosis, detail, hint].filter(Boolean);
  if (parts.length > 0) return parts.join(" — ");

  // Nothing structured matched — surface the last non-empty lines (the tail holds
  // the real error) rather than the "Saving debug log" opener.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).join(" · ") || `certbot failed to issue a certificate for ${domain}`;
}

interface FileSnapshot {
  exists: boolean;
  content?: string;
}


// ─── Implementation ──────────────────────────────────────────────────────────

export class NginxProvider implements RoutingProvider, SslProvider {
  private sitesDir: string;
  private readonly acmeEmail: string | undefined;
  private readonly certDir: string;
  private readonly executor: CommandExecutor | null;
  private reloadCommand: string;

  constructor(opts: NginxProviderOptions) {
    this.sitesDir = opts.paths.sitesDir;
    this.acmeEmail = opts.acmeEmail;
    this.certDir = opts.certDir ?? DEFAULT_CERT_DIR;
    this.executor = opts.executor ?? null;
    this.reloadCommand = buildReloadCommand(opts.paths);
  }

  // ── File operation helpers (dual-path: local or remote) ──────────────

  private async _writeFile(path: string, content: string): Promise<void> {
    // Random suffix (not just pid+ms) so two same-ms writes to the same conf
    // can't collide on the temp path and defeat the atomic rename.
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;

    if (this.executor) {
      try {
        await this.executor.writeFile(tmpPath, content);
        await this.executor.exec(`mv ${sq(tmpPath)} ${sq(path)}`);
      } catch (err) {
        await this.executor.rm(tmpPath).catch(() => undefined);
        throw err;
      }
    } else {
      await fsMkdir(dirname(path), { recursive: true });
      try {
        await fsWriteFile(tmpPath, content, "utf-8");
        await fsRename(tmpPath, path);
      } catch (err) {
        await fsRm(tmpPath).catch(() => undefined);
        throw err;
      }
    }
  }

  private async _readFile(path: string): Promise<string> {
    if (this.executor) {
      return this.executor.readFile(path);
    }
    return fsReadFile(path, "utf-8");
  }

  private async _exists(path: string): Promise<boolean> {
    if (this.executor) {
      return this.executor.exists(path);
    }

    try {
      await fsAccess(path);
      return true;
    } catch {
      return false;
    }
  }

  private async _rm(path: string): Promise<void> {
    if (this.executor) {
      await this.executor.rm(path);
    } else {
      try {
        await fsRm(path);
      } catch {
        // Already gone
      }
    }
  }

  private async _mkdir(path: string): Promise<void> {
    if (this.executor) {
      await this.executor.mkdir(path);
    } else {
      await fsMkdir(path, { recursive: true });
    }
  }

  private async _exec(command: string, args: string[] = []): Promise<string> {
    if (this.executor) {
      // Remote path runs through a login shell (ssh2 exec), so every arg MUST
      // be shell-quoted — otherwise a value like an ACME email carrying `;`,
      // `$()`, or backticks executes as a command on the managed server (root).
      // The local branch below is argv-based (execFile) and needs no quoting.
      const full = args.length ? `${command} ${args.map(sq).join(" ")}` : command;
      return this.executor.exec(full);
    }
    try {
      const { stdout } = await execFileAsync(command, args);
      return stdout;
    } catch (err) {
      // execFile's error carries stdout/stderr as props but NOT in .message
      // ("Command failed: certbot …"). Fold them in so the caller (and the
      // certbot summarizer) sees the real output, not just the exit boilerplate.
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const detail = [e.stderr?.trim(), e.stdout?.trim()].filter(Boolean).join("\n");
      throw new Error(detail || e.message || String(err));
    }
  }

  private async _captureFile(path: string): Promise<FileSnapshot> {
    if (!(await this._exists(path))) {
      return { exists: false };
    }

    return {
      exists: true,
      content: await this._readFile(path),
    };
  }

  private async _restoreFile(path: string, snapshot: FileSnapshot): Promise<void> {
    if (!snapshot.exists) {
      await this._rm(path);
      return;
    }

    await this._writeFile(path, snapshot.content ?? "");
  }

  // ── Routing ──────────────────────────────────────────────────────────

  /**
   * Register a route by writing an OpenResty server block.
   *
   * Creates a conf file in sites-enabled, then reloads.
   * If TLS is enabled and certs exist, configures SSL. If certs don't
   * exist yet, writes an HTTP-only block (certbot will add SSL later
   * via provisionCert).
   */
  async registerRoute(route: RouteConfig): Promise<void> {
    assertValidDomain(route.domain);
    await this._mkdir(this.sitesDir);

    const slug = this.domainSlug(route.domain);
    const configPath = join(this.sitesDir, `${slug}.conf`);
    if ("staticRoot" in route && route.staticRoot) {
      assertValidStaticRoot(route.staticRoot);
    } else {
      assertValidUpstream((route as { targetUrl: string }).targetUrl);
    }
    const locationBody = "staticRoot" in route && route.staticRoot
      ? `root ${route.staticRoot};
        index index.html;
        try_files $uri $uri/ /index.html;`
      : `proxy_pass ${(route as { targetUrl: string }).targetUrl};
        ${PROXY_HEADERS}`;

    // Composite single-domain: extra path-prefix proxy locations (e.g. /api/ →
    // backend) + vercel.json redirects, emitted BEFORE `location /` so nginx
    // longest-prefix / exact match routes them ahead of the primary target.
    const extraLocations = `${renderRedirects(route)}${renderProxyLocations(route)}`;
    // Global response headers (vercel.json `headers` with source "/(.*)").
    const serverHeaders = renderServerHeaders(route);
    // Curated reverse-proxy tunables (client_max_body_size, timeouts, gzip, …).
    // Server-scope so they cover `location /` + every extra location, and
    // override the server-wide http default for this vhost.
    const proxyOpts = renderProxyOptions(route.proxy);

    // Optional: webhook proxy location for GitHub push delivery
    const webhookLocation = route.webhookProxy
      ? `
    location /_openship/hooks/ {
        proxy_pass ${route.webhookProxy};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
`
      : "";

    // Fail-safe: only emit the Lua directives when the scripts are actually
    // installable. On a build that dropped the Lua from its bundle, referencing
    // a missing file makes OpenResty 500 EVERY request (total outage). Omitting
    // them means the edge rules-engine + analytics logging are off, but the site
    // SERVES. luaSourceAvailable() is the same signal the installer gates on.
    const edgeLua = luaSourceAvailable();
    const luaLogOnly = edgeLua ? `    log_by_lua_file ${LUA_LOGGER_PATH};` : "";
    const luaProxy = edgeLua
      ? `    log_by_lua_file ${LUA_LOGGER_PATH};\n    access_by_lua_file ${RULES_GUARD_PATH};`
      : "";

    let serverBlock: string;

    if (route.tls && (await this.certsExist(route.domain))) {
      const certPath = join(this.certDir, route.domain, "fullchain.pem");
      const keyPath = join(this.certDir, route.domain, "privkey.pem");
      // Full SSL config - certs already provisioned
      serverBlock = `# Auto-generated by Openship - do not edit manually
server {
    listen 80;
    server_name ${route.domain};

${luaLogOnly}

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ${route.domain};

${luaProxy}

    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
${serverHeaders}${proxyOpts}
${webhookLocation}${extraLocations}
    location / {
        ${locationBody}
    }
}
`;
    } else {
      // HTTP-only - certbot will add SSL block via provisionCert()
      serverBlock = `# Auto-generated by Openship - do not edit manually
server {
    listen 80;
    server_name ${route.domain};

${luaProxy}
${serverHeaders}${proxyOpts}
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
${webhookLocation}${extraLocations}
    location / {
        ${locationBody}
    }
}
`;
    }

    // Snapshot the prior conf so a block that fails `openresty -t` can be
    // rolled back — otherwise a bad conf stays on disk and poisons every
    // subsequent reload box-wide (same self-rollback applyRateLimit uses).
    const snapshot = await this._captureFile(configPath);
    await this._writeFile(configPath, serverBlock);
    try {
      await this.reload();
    } catch (err) {
      await this._restoreFile(configPath, snapshot);
      await this.reload().catch(() => undefined);
      throw err;
    }

    // Persist the full RouteConfig alongside the conf so `provisionCert` can
    // re-register the EXACT route (proxyLocations + webhookProxy) after issuing a
    // cert, instead of regex-reconstructing it from the generated conf (which
    // only recovered the primary target and dropped composite locations).
    await this._writeFile(this.routeStatePath(slug), JSON.stringify(route)).catch(() => undefined);
  }

  private routeStatePath(slug: string): string {
    return join(this.sitesDir, `${slug}.route.json`);
  }

  /**
   * Remove a route by deleting its conf file, then reload.
   */
  async removeRoute(domain: string): Promise<void> {
    assertValidDomain(domain);
    const slug = this.domainSlug(domain);
    const configPath = join(this.sitesDir, `${slug}.conf`);
    await this._rm(configPath);
    await this._rm(this.routeStatePath(slug)).catch(() => undefined);
    await this.reload();
  }

  // ── SSL ──────────────────────────────────────────────────────────────

  /**
   * Provision a TLS certificate using certbot.
   *
   * Runs `certbot certonly` in webroot mode using the ACME challenge
   * directory served by OpenResty, then rewrites the config to include
   * SSL and reloads.
   *
   * Only --webroot is attempted. The previous --standalone fallback was
   * dead code on any normal install: certbot --standalone binds to port
   * 80 itself, but OpenResty already owns 80 on the same box, so the
   * fallback would always fail with EADDRINUSE — amplifying a transient
   * --webroot failure into an immediate hard error. The caller
   * (route-registration.ts) already wraps provisionCert in try/catch so
   * a webroot failure becomes a "deploy continues on HTTP, retry from
   * Domains tab" warning instead of a deploy abort.
   */
  async provisionCert(domain: string): Promise<SslResult> {
    assertValidDomain(domain);

    // Check if cert already exists
    if (await this.certsExist(domain)) {
      return this.readCertInfo(domain);
    }

    // Defense-in-depth: only pass acmeEmail when it's a plausible address.
    // (_exec now shell-quotes every arg, but a garbage/injection-shaped value
    // has no business reaching certbot — drop it rather than register with it.)
    const validEmail = !!this.acmeEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.acmeEmail);
    const emailArgs = validEmail
      ? ["--email", this.acmeEmail as string]
      : ["--register-unsafely-without-email"];

    try {
      await this._exec("certbot", [
        "certonly", "--webroot", "-w", "/var/www/acme", "-d", domain,
        ...emailArgs, "--agree-tos", "--non-interactive",
      ]);
    } catch (err) {
      // Replace certbot's opaque opener with the real, actionable cause.
      throw new Error(summarizeCertbotFailure(safeErrorMessage(err), domain));
    }

    // Rewrite the config with SSL now that certs exist
    const slug = this.domainSlug(domain);
    const configPath = join(this.sitesDir, `${slug}.conf`);

    // Prefer the persisted RouteConfig sidecar so the re-register keeps every
    // location (composite proxyLocations + webhookProxy), not just the primary.
    try {
      const state = await this._readFile(this.routeStatePath(slug));
      const saved = JSON.parse(state) as RouteConfig;
      await this.registerRoute({ ...saved, domain, tls: true });
      return this.readCertInfo(domain);
    } catch {
      // No sidecar (legacy route or unreadable) - fall back to scraping the conf.
    }

    try {
      const existing = await this._readFile(configPath);
      const targetMatch = existing.match(/proxy_pass\s+([^;]+);/);
      if (targetMatch) {
        await this.registerRoute({ domain, targetUrl: targetMatch[1], tls: true });
        return this.readCertInfo(domain);
      }

      const rootMatch = existing.match(/root\s+([^;]+);/);
      if (rootMatch) {
        await this.registerRoute({ domain, staticRoot: rootMatch[1], tls: true });
        return this.readCertInfo(domain);
      }
    } catch {
      // Config doesn't exist - cert provisioned but no route yet
    }

    return this.readCertInfo(domain);
  }

  /**
   * Renew a TLS certificate using certbot.
   */
  async renewCert(domain: string): Promise<SslResult> {
    assertValidDomain(domain);

    // `certbot renew` only acts on certs that ALREADY exist. A domain that
    // never got its first cert (initial provision failed, or was skipped)
    // has nothing to renew — certbot exits 0 doing nothing, so the caller
    // sees "renewed" while the domain stays stuck in `provisioning`. When no
    // cert exists yet, "renew" must mean "obtain the first one" → delegate to
    // provisionCert (certbot certonly), which also rewrites the vhost with the
    // 443/ssl block and reloads. This is what makes the Renew button able to
    // bootstrap a domain that has only an HTTP vhost.
    if (!(await this.certsExist(domain))) {
      return this.provisionCert(domain);
    }

    await this._exec("certbot", ["renew", "--cert-name", domain, "--non-interactive"]);
    await this.reload();

    return this.readCertInfo(domain);
  }

  /**
   * Install an operator-supplied certificate (no ACME). Validates the PEM pair,
   * writes it to the same on-disk path certbot uses, then re-registers the vhost
   * with TLS — mirroring provisionCert's tail so composite routes are preserved.
   */
  async installCert(domain: string, cert: ManualCert): Promise<SslResult> {
    assertValidDomain(domain);

    // Validate before touching disk: the cert must parse and the key must
    // actually match it, or OpenResty would fail to reload on a broken pair.
    let expiresAt: string;
    try {
      const x509 = new X509Certificate(cert.certPem);
      const key = createPrivateKey(cert.keyPem);
      if (!x509.checkPrivateKey(key)) {
        throw new Error("private key does not match certificate");
      }
      expiresAt = new Date(x509.validTo).toISOString();
    } catch (err) {
      throw new Error(`Invalid certificate: ${safeErrorMessage(err)}`);
    }

    const dir = join(this.certDir, domain);
    await this._mkdir(dir);
    await this._writeFile(join(dir, "fullchain.pem"), cert.certPem);
    await this._writeFile(join(dir, "privkey.pem"), cert.keyPem);

    // Re-register the vhost with TLS now that the cert is on disk. Prefer the
    // persisted RouteConfig sidecar so every location survives (same as
    // provisionCert); if there's no route yet, the next deploy's route plan
    // picks up tls:true from the manualSsl gate.
    const slug = this.domainSlug(domain);
    try {
      const state = await this._readFile(this.routeStatePath(slug));
      const saved = JSON.parse(state) as RouteConfig;
      await this.registerRoute({ ...saved, domain, tls: true });
    } catch {
      // No sidecar (domain not routed yet) — cert is staged on disk regardless.
    }

    return { domain, expiresAt, issuer: "manual", verified: true, reason: "issued" };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private domainSlug(domain: string): string {
    return domain.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-");
  }

  /**
   * Re-detect OpenResty paths and reload.
   *
   * Paths can become stale after an OpenResty reinstall (the binary or
   * config may move). Re-detecting on every reload keeps the provider
   * in sync without requiring an API restart.
   */
  private async reload(): Promise<void> {
    if (this.executor) {
      try {
        const freshPaths = await detectOpenRestyPaths(this.executor);
        this.sitesDir = freshPaths.sitesDir;
        this.reloadCommand = buildReloadCommand(freshPaths);
      } catch {
        // Detection failed - fall through with current cached paths
      }
      await this.executor.exec(this.reloadCommand);
      return;
    }

    await execFileAsync("sh", ["-lc", this.reloadCommand]);
  }

  private async certsExist(domain: string): Promise<boolean> {
    const certPath = join(this.certDir, domain, "fullchain.pem");
    if (this.executor) {
      return this.executor.exists(certPath);
    }
    try {
      await fsReadFile(certPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the on-disk cert and report its validity. Distinguishes three cases so
   * the caller never downgrades a healthy domain on a transient hiccup:
   *   - file present + parses  → verified, real expiry
   *   - file ABSENT            → not verified, reason "missing"  (no cert yet)
   *   - file present, unreadable/unparseable → not verified, reason "read_error"
   */
  private async readCertInfo(domain: string): Promise<SslResult> {
    if (!(await this.certsExist(domain))) {
      return { domain, expiresAt: "", issuer: "certbot", verified: false, reason: "missing" };
    }
    try {
      const certPath = join(this.certDir, domain, "fullchain.pem");
      const pem = await this._readFile(certPath);
      const { X509Certificate } = await import("node:crypto");
      const cert = new X509Certificate(pem);
      return {
        domain,
        expiresAt: new Date(cert.validTo).toISOString(),
        issuer: "certbot",
        verified: true,
      };
    } catch {
      // Cert file exists but couldn't be read/parsed (SSH blip, permissions,
      // partial write). Transient — caller must NOT treat this as "no cert".
      return { domain, expiresAt: "", issuer: "certbot", verified: false, reason: "read_error" };
    }
  }

  /**
   * Read-only check that the Let's Encrypt cert is actually present + valid on
   * the serving host. No certbot, no config rewrite — safe to call any time
   * (deploy, "Recheck SSL" button).
   */
  async verifyCert(domain: string): Promise<SslResult> {
    assertValidDomain(domain);
    return this.readCertInfo(domain);
  }

  // ── Rate Limiting ──────────────────────────────────────────────────

  /** Dedicated include dir for Openship-managed OpenResty snippets. */
  private get rateLimitIncludeDir(): string {
    return join(dirname(this.sitesDir), "openship-includes");
  }

  /** Path to the managed rate-limit snippet inside the dedicated include dir. */
  private get rateLimitConfPath(): string {
    return join(this.rateLimitIncludeDir, "ratelimit.conf");
  }

  /**
   * Apply rate limit configuration to OpenResty.
   *
   * Writes a `ratelimit.conf` snippet with geo whitelist, map, and
   * limit_req_zone directives. Ensures an `include` for it exists in
   * nginx.conf's http block. Then validates + reloads.
   *
   * Pass rps=0 to disable rate limiting entirely.
   */
  async applyRateLimit(config: RateLimitConfig): Promise<void> {
    const confPath = this.rateLimitConfPath;
    const nginxConfPath = join(dirname(this.sitesDir), "nginx.conf");
    const snapshots = {
      nginx: await this._captureFile(nginxConfPath),
      current: await this._captureFile(confPath),
    };

    // Build geo block - whitelist loopback + user-specified CIDRs
    const geoEntries = renderGeoEntries(config.whitelist);

    const snippet = `# Auto-generated by Openship - rate limit config
# Edit via Settings > Rate Limiting in the dashboard

geo $whitelist {
${geoEntries.join("\n")}
    }

    map $whitelist $limit_key {
        1   "";
        0   $binary_remote_addr;
    }

    limit_req_zone $limit_key zone=global_limit:10m rate=${config.rps}r/s;
    limit_req zone=global_limit burst=${config.burst} nodelay;
    limit_req_status 429;
`;

    try {
      await this.ensureRateLimitInclude();

      if (config.rps <= 0) {
        await this._rm(confPath);
      } else {
        await this._mkdir(this.rateLimitIncludeDir);
        await this._writeFile(confPath, snippet);
      }

      await this.reload();
    } catch (err) {
      let rollbackError: string | null = null;

      try {
        await this._restoreFile(confPath, snapshots.current);
        await this._restoreFile(nginxConfPath, snapshots.nginx);
        await this.reload();
      } catch (restoreErr) {
        rollbackError = safeErrorMessage(restoreErr);
      }

      const message = safeErrorMessage(err);
      if (rollbackError) {
        throw new Error(`${message}; rollback failed: ${rollbackError}`);
      }
      throw err;
    }
  }

  /**
   * Read the current rate limit config from the snippet file.
   * Returns a disabled config when the snippet doesn't exist yet.
   * Returns null only when the file exists but couldn't be read or parsed.
   */
  async getRateLimitConfig(): Promise<RateLimitConfig | null> {
    try {
      const confPath = this.rateLimitConfPath;
      if (!(await this._exists(confPath))) {
        return { rps: 0, burst: 0, whitelist: [] };
      }

      const content = await this._readFile(confPath);
      if (content.includes("disabled")) return { rps: 0, burst: 0, whitelist: [] };

      // Parse rps from: rate=50r/s
      const rpsMatch = content.match(/rate=(\d+)r\/s/);
      const rps = rpsMatch ? parseInt(rpsMatch[1], 10) : 50;

      // Parse burst from: burst=20
      const burstMatch = content.match(/burst=(\d+)/);
      const burst = burstMatch ? parseInt(burstMatch[1], 10) : 20;

      // Parse whitelist from geo block - lines with "1;" that aren't default/loopback
      const whitelist: string[] = [];
      const geoBlock = content.match(/geo \$whitelist \{([\s\S]*?)\}/);
      if (geoBlock) {
        const lines = geoBlock[1].split("\n");
        for (const line of lines) {
          const m = line.match(/^\s+([\da-fA-F.:\/]+)\s+1;/);
          if (m && !["127.0.0.1/32", "::1/128"].includes(m[1]) && m[1] !== "default") {
            whitelist.push(m[1]);
          }
        }
      }

      return { rps, burst, whitelist };
    } catch {
      return null;
    }
  }

  /**
   * Ensure nginx.conf includes the rate limit snippet in its http block.
   */
  private async ensureRateLimitInclude(): Promise<void> {
    const confDir = dirname(this.sitesDir);
    const confPath = join(confDir, "nginx.conf");
    const desiredIncludeLine = `include ${this.rateLimitIncludeDir}/*.conf;`;
    const content = await this._readFile(confPath);
    const trailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    const nextLines: string[] = [];
    let foundDesiredInclude = false;
    let changed = false;

    await this._mkdir(this.rateLimitIncludeDir);

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === desiredIncludeLine) {
        if (foundDesiredInclude) {
          // Duplicate include — keep only the first.
          changed = true;
          continue;
        }
        foundDesiredInclude = true;
      }

      nextLines.push(line);
    }

    if (!foundDesiredInclude) {
      const httpIndex = nextLines.findIndex((line) => /^\s*http\s*\{\s*$/.test(line));
      if (httpIndex === -1) {
        throw new Error(`Failed to ensure rate-limit include: ${confPath} is missing an http block`);
      }

      const indent = nextLines[httpIndex].match(/^\s*/)?.[0] ?? "";
      nextLines.splice(httpIndex + 1, 0, `${indent}    ${desiredIncludeLine}`);
      changed = true;
    }

    if (changed) {
      const nextContent = nextLines.join("\n");
      await this._writeFile(confPath, trailingNewline ? `${nextContent}\n` : nextContent);
    }
  }
}
