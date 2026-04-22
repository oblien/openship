/**
 * OpenResty infrastructure provider — routing + SSL for self-hosted deployments.
 *
 * Writes server block config files to a directory that OpenResty `include`s,
 * then reloads. SSL is handled by certbot (Let's Encrypt) running
 * as a separate process — OpenResty just reads the cert files.
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
import { promisify } from "node:util";
import { dirname, join } from "node:path";

import type { CommandExecutor, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider } from "./types";
import { LUA_LOGGER_PATH, buildReloadCommand, detectOpenRestyPaths, type OpenRestyPaths } from "./openresty-lua";

// ─── Rate Limit Config ──────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Requests per second (0 = disabled) */
  rps: number;
  /** Burst allowance (extra requests above rate, queued with nodelay) */
  burst: number;
  /** CIDR strings whitelisted from rate limiting (e.g. ["127.0.0.1/32", "10.0.0.0/8"]) */
  whitelist: string[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NginxProviderOptions {
  /**
   * Detected OpenResty paths — from detectOpenRestyPaths().
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

/** Only allow valid domain characters — prevents shell injection. */
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function assertValidDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain) || domain.length > 253) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

const execFileAsync = promisify(cpExecFile);

interface FileSnapshot {
  exists: boolean;
  content?: string;
}

function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;

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
      // Remote: executor handles the command as a single string
      const full = args.length ? `${command} ${args.join(" ")}` : command;
      return this.executor.exec(full);
    }
    const { stdout } = await execFileAsync(command, args);
    return stdout;
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
    const locationBody = "staticRoot" in route
      ? `root ${route.staticRoot};
        index index.html;
        try_files $uri $uri/ /index.html;`
      : `proxy_pass ${route.targetUrl};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";`;

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

    let serverBlock: string;

    if (route.tls && (await this.certsExist(route.domain))) {
      const certPath = join(this.certDir, route.domain, "fullchain.pem");
      const keyPath = join(this.certDir, route.domain, "privkey.pem");
      // Full SSL config — certs already provisioned
      serverBlock = `# Auto-generated by Openship — do not edit manually
server {
    listen 80;
    server_name ${route.domain};

    log_by_lua_file ${LUA_LOGGER_PATH};

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

    log_by_lua_file ${LUA_LOGGER_PATH};

    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
${webhookLocation}
    location / {
        ${locationBody}
    }
}
`;
    } else {
      // HTTP-only — certbot will add SSL block via provisionCert()
      serverBlock = `# Auto-generated by Openship — do not edit manually
server {
    listen 80;
    server_name ${route.domain};

    log_by_lua_file ${LUA_LOGGER_PATH};

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
${webhookLocation}
    location / {
        ${locationBody}
    }
}
`;
    }

    await this._writeFile(configPath, serverBlock);
    await this.reload();
  }

  /**
   * Remove a route by deleting its conf file, then reload.
   */
  async removeRoute(domain: string): Promise<void> {
    assertValidDomain(domain);
    const slug = this.domainSlug(domain);
    const configPath = join(this.sitesDir, `${slug}.conf`);
    await this._rm(configPath);
    await this.reload();
  }

  // ── SSL ──────────────────────────────────────────────────────────────

  /**
   * Provision a TLS certificate using certbot.
   *
   * Runs `certbot certonly` in webroot mode using the ACME challenge
   * directory served by OpenResty, then rewrites the config to include
   * SSL and reloads.
   */
  async provisionCert(domain: string): Promise<SslResult> {
    assertValidDomain(domain);

    // Check if cert already exists
    if (await this.certsExist(domain)) {
      return this.readCertInfo(domain);
    }

    // Run certbot — use webroot mode (OpenResty serves the challenge files),
    // falling back to standalone if webroot fails
    const emailArgs = this.acmeEmail
      ? ["--email", this.acmeEmail]
      : ["--register-unsafely-without-email"];

    try {
      await this._exec("certbot", [
        "certonly", "--webroot", "-w", "/var/www/acme", "-d", domain,
        ...emailArgs, "--agree-tos", "--non-interactive",
      ]);
    } catch {
      // Fallback to standalone mode
      await this._exec("certbot", [
        "certonly", "--standalone", "-d", domain,
        ...emailArgs, "--agree-tos", "--non-interactive",
      ]);
    }

    // Rewrite the config with SSL now that certs exist
    const slug = this.domainSlug(domain);
    const configPath = join(this.sitesDir, `${slug}.conf`);

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
      // Config doesn't exist — cert provisioned but no route yet
    }

    return this.readCertInfo(domain);
  }

  /**
   * Renew a TLS certificate using certbot.
   */
  async renewCert(domain: string): Promise<SslResult> {
    assertValidDomain(domain);
    await this._exec("certbot", ["renew", "--cert-name", domain, "--non-interactive"]);
    await this.reload();

    return this.readCertInfo(domain);
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
        // Detection failed — fall through with current cached paths
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

  private async readCertInfo(domain: string): Promise<SslResult> {
    try {
      const certPath = join(this.certDir, domain, "fullchain.pem");
      const pem = await this._readFile(certPath);
      const { X509Certificate } = await import("node:crypto");
      const cert = new X509Certificate(pem);
      return {
        domain,
        expiresAt: new Date(cert.validTo).toISOString(),
        issuer: "certbot",
      };
    } catch {
      return { domain, expiresAt: "", issuer: "certbot" };
    }
  }

  // ── Rate Limiting ──────────────────────────────────────────────────

  /** Legacy single-file include path used before the dedicated include dir. */
  private get legacyRateLimitConfPath(): string {
    return join(dirname(this.sitesDir), "ratelimit.conf");
  }

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
    const legacyConfPath = this.legacyRateLimitConfPath;
    const nginxConfPath = join(dirname(this.sitesDir), "nginx.conf");
    const snapshots = {
      nginx: await this._captureFile(nginxConfPath),
      current: await this._captureFile(confPath),
      legacy: await this._captureFile(legacyConfPath),
    };

    // Build geo block — whitelist loopback + user-specified CIDRs
    const geoEntries = [
      "        default         0;",
      "        127.0.0.1/32    1;",
      "        ::1/128         1;",
    ];
    for (const cidr of config.whitelist) {
      // Validate CIDR format loosely (prevents injection)
      if (/^[\da-fA-F.:\/]+$/.test(cidr) && cidr.length <= 50) {
        geoEntries.push(`        ${cidr.padEnd(16)}1;`);
      }
    }

    const snippet = `# Auto-generated by Openship — rate limit config
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
        await this._rm(legacyConfPath);
      } else {
        await this._mkdir(this.rateLimitIncludeDir);
        await this._writeFile(confPath, snippet);
        await this._rm(legacyConfPath);
      }

      await this.reload();
    } catch (err) {
      let rollbackError: string | null = null;

      try {
        await this._restoreFile(confPath, snapshots.current);
        await this._restoreFile(legacyConfPath, snapshots.legacy);
        await this._restoreFile(nginxConfPath, snapshots.nginx);
        await this.reload();
      } catch (restoreErr) {
        rollbackError = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      }

      const message = err instanceof Error ? err.message : String(err);
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
      const confPath = await this._exists(this.rateLimitConfPath)
        ? this.rateLimitConfPath
        : await this._exists(this.legacyRateLimitConfPath)
          ? this.legacyRateLimitConfPath
          : null;

      if (!confPath) {
        return { rps: 0, burst: 0, whitelist: [] };
      }

      const content = await this._readFile(confPath);
      // Backward compatibility for older deployments that wrote a disabled marker.
      if (content.includes("disabled")) return { rps: 0, burst: 0, whitelist: [] };

      // Parse rps from: rate=50r/s
      const rpsMatch = content.match(/rate=(\d+)r\/s/);
      const rps = rpsMatch ? parseInt(rpsMatch[1], 10) : 50;

      // Parse burst from: burst=20
      const burstMatch = content.match(/burst=(\d+)/);
      const burst = burstMatch ? parseInt(burstMatch[1], 10) : 20;

      // Parse whitelist from geo block — lines with "1;" that aren't default/loopback
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
    const legacyIncludeLine = `include ${this.legacyRateLimitConfPath};`;
    const optionalLegacyIncludeLine = `include ${this.legacyRateLimitConfPath}*;`;
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
          changed = true;
          continue;
        }

        foundDesiredInclude = true;
        nextLines.push(line);
        continue;
      }

      if (trimmed === legacyIncludeLine || trimmed === optionalLegacyIncludeLine) {
        const indent = line.match(/^\s*/)?.[0] ?? "    ";

        if (!foundDesiredInclude) {
          nextLines.push(`${indent}${desiredIncludeLine}`);
          foundDesiredInclude = true;
        }

        changed = true;
        continue;
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
