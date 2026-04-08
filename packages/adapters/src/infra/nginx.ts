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
  writeFile as fsWriteFile,
  rm as fsRm,
  mkdir as fsMkdir,
  readFile as fsReadFile,
} from "node:fs/promises";
import { execFile as cpExecFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

import type { CommandExecutor, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider } from "./types";
import { LUA_LOGGER_PATH } from "./openresty-lua";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NginxProviderOptions {
  /**
   * Directory where site server blocks are written.
   * Default: /usr/local/openresty/nginx/conf/sites-enabled
   */
  sitesDir?: string;
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

const DEFAULT_SITES_DIR = "/usr/local/openresty/nginx/conf/sites-enabled";
const DEFAULT_CERT_DIR = "/etc/letsencrypt/live";

/** Only allow valid domain characters — prevents shell injection. */
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function assertValidDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain) || domain.length > 253) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

const execFileAsync = promisify(cpExecFile);

// ─── Implementation ──────────────────────────────────────────────────────────

export class NginxProvider implements RoutingProvider, SslProvider {
  private readonly sitesDir: string;
  private readonly acmeEmail: string | undefined;
  private readonly certDir: string;
  private readonly executor: CommandExecutor | null;

  constructor(opts?: NginxProviderOptions) {
    this.sitesDir = opts?.sitesDir ?? DEFAULT_SITES_DIR;
    this.acmeEmail = opts?.acmeEmail;
    this.certDir = opts?.certDir ?? DEFAULT_CERT_DIR;
    this.executor = opts?.executor ?? null;
  }

  // ── File operation helpers (dual-path: local or remote) ──────────────

  private async _writeFile(path: string, content: string): Promise<void> {
    if (this.executor) {
      await this.executor.writeFile(path, content);
    } else {
      await fsMkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, "utf-8");
    }
  }

  private async _readFile(path: string): Promise<string> {
    if (this.executor) {
      return this.executor.readFile(path);
    }
    return fsReadFile(path, "utf-8");
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
      ? `root ${route.staticRoot};\n        index index.html;\n        try_files $uri $uri/ /index.html;`
      : `proxy_pass ${route.targetUrl};\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";`;

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

  private async reload(): Promise<void> {
    // Test config first, then reload — two separate commands for safety.
    // These must fail loudly; otherwise deploy can report success while the
    // route never became active.
    await this._exec("openresty", ["-t"]);
    await this._exec("openresty", ["-s", "reload"]);
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
}
