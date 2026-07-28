import { describe, expect, test } from "vitest";
import { NginxProvider, renderProxyOptions } from "./nginx";
import { PROXY_GZIP_TYPES } from "@repo/core";
import { OPENRESTY_DEFAULT_PATHS, luaSourceAvailable, RULES_GUARD_PATH, ACME_HTTP01_PORT, ensureOpenRestyConfig } from "./openresty-lua";
import type { CommandExecutor, RouteConfig } from "../types";

// L1 — config GENERATION. Proves NginxProvider emits the right nginx directives
// for each branch, that the injection guard holds, and that a failed
// `openresty -t` rolls the vhost back. It does NOT prove real nginx accepts the
// output — that's the L3 docker suite. (See the routing-rules test audit.)

const SITES = "/tmp/openship-nginx-test/sites-enabled";
const PATHS = { ...OPENRESTY_DEFAULT_PATHS, sitesDir: SITES };

interface FakeOpts {
  /** Simulate `openresty -t` failing inside the reload script. */
  failReload?: boolean;
  /** Domains whose Let's Encrypt fullchain exists (drives the TLS branch). */
  certDomains?: string[];
}

/** Stateful fake executor: in-memory file map + atomic-rename (`mv`) handling.
 *  Detection commands throw so reload() keeps the cached sitesDir. */
function makeExecutor(files: Map<string, string>, opts: FakeOpts, calls: string[]): CommandExecutor {
  const exec = async (command: string): Promise<string> => {
    calls.push(command);
    // openresty path detection (reload re-detects) → fail so cached paths stick.
    if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
    const mv = command.match(/^mv '([^']+)' '([^']+)'$/);
    if (mv) {
      const c = files.get(mv[1]);
      if (c !== undefined) { files.set(mv[2], c); files.delete(mv[1]); }
      return "";
    }
    // The reload script contains `-t ... -s reload`; a `-t` failure exits non-zero.
    if (command.includes("-s reload")) {
      if (opts.failReload) throw new Error("nginx: [emerg] configuration test failed");
      return "";
    }
    return "";
  };
  return {
    exec,
    writeFile: async (p: string, c: string) => { files.set(p, c); },
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) =>
      files.has(p) || (opts.certDomains ?? []).some((d) => p.startsWith(`/etc/letsencrypt/live/${d}/`)),
    mkdir: async () => {},
    rm: async (p: string) => { files.delete(p); },
  } as unknown as CommandExecutor;
}

function setup(opts: FakeOpts = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const nginx = new NginxProvider({ paths: PATHS, executor: makeExecutor(files, opts, calls) });
  return { nginx, files, calls, conf: (slug: string) => files.get(`${SITES}/${slug}.conf`) };
}

const PROXY: RouteConfig = { domain: "app.example.com", tls: true, targetUrl: "http://127.0.0.1:3009" };

describe("NginxProvider config generation", () => {
  test("proxy route with no cert yet → HTTP-only block", async () => {
    const { nginx, conf, files } = setup();
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(c).toBeDefined();
    expect(c).toContain("server_name app.example.com;");
    expect(c).toContain("listen 80;");
    expect(c).not.toContain("listen 443 ssl;"); // no cert → no TLS server
    expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
    expect(c).toContain("location /.well-known/acme-challenge/");
    // ACME challenge is proxied to certbot's standalone server (not a webroot).
    expect(c).toContain(`proxy_pass http://127.0.0.1:${ACME_HTTP01_PORT};`);
    expect(c).not.toContain("root /var/www/acme;");
    // Lua rules-guard hook is emitted only when the Lua source ships (fail-safe).
    if (luaSourceAvailable()) {
      expect(c).toContain(`access_by_lua_file ${RULES_GUARD_PATH};`);
    } else {
      expect(c).not.toContain("access_by_lua_file");
    }
    // Sidecar persisted so cert re-registration reproduces the exact route.
    const sidecar = files.get(`${SITES}/app-example-com.route.json`);
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar!)).toMatchObject({ domain: "app.example.com", targetUrl: "http://127.0.0.1:3009" });
  });

  test("proxy route WITH cert → 80→443 redirect + ssl server", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(c).toContain("return 301 https://$server_name$request_uri;");
    expect(c).toContain("listen 443 ssl;");
    expect(c).toContain("ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;");
    expect(c).toContain("ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;");
    expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
  });

  test("static route → root + try_files, app is not proxied", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ domain: "site.example.com", tls: false, staticRoot: "/var/www/site" });
    const c = conf("site-example-com")!;
    expect(c).toContain("root /var/www/site;");
    expect(c).toContain("try_files $uri $uri/ /index.html;");
    // The ONLY proxy_pass allowed on a static vhost is the ACME-challenge
    // location (→ certbot's standalone server); the app itself is served, not
    // proxied. Assert no UPSTREAM/app proxy, rather than a blanket absence.
    expect(c).not.toContain("proxy_pass http://upstream");
    expect(c.match(/proxy_pass/g)?.length ?? 0).toBe(1);
  });

  test("provisionCert issues via certbot --standalone on the ACME alt-port", async () => {
    const { nginx, calls } = setup(); // domain NOT in certDomains → certbot runs
    await nginx.registerRoute(PROXY);
    // The fake certbot produces no cert, so ensureIssued throws — we only care
    // that certbot was invoked with the standalone/alt-port/cert-name args.
    await expect(nginx.provisionCert("app.example.com")).rejects.toThrow();
    const certbot = calls.find((c) => c.startsWith("certbot 'certonly'") || c.startsWith("certbot certonly"));
    expect(certbot).toBeDefined();
    expect(certbot).toContain("--standalone");
    expect(certbot).toContain("--http-01-port");
    expect(certbot).toContain(String(ACME_HTTP01_PORT));
    expect(certbot).toContain("--cert-name");
    expect(certbot).not.toContain("--webroot");
  });

  test("webhook proxy adds the /_openship/hooks/ location", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, webhookProxy: "http://127.0.0.1:4000/api/webhooks/" });
    expect(conf("app-example-com")!).toContain("location /_openship/hooks/");
  });

  test("rejects a domain with shell metacharacters (injection guard)", async () => {
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({ domain: "bad;rm -rf /", tls: false, targetUrl: "http://x" }),
    ).rejects.toThrow(/Invalid domain/);
  });

  test("reload validates (-t) BEFORE -s reload", async () => {
    const { nginx, calls } = setup();
    await nginx.registerRoute(PROXY);
    const reloadCmd = calls.find((c) => c.includes("-s reload"));
    expect(reloadCmd).toBeDefined();
    expect(reloadCmd!.indexOf(" -t")).toBeGreaterThanOrEqual(0);
    expect(reloadCmd!.indexOf(" -t")).toBeLessThan(reloadCmd!.indexOf("-s reload"));
  });

  test("a failed `openresty -t` rolls the vhost back to the prior config", async () => {
    const { nginx, files, conf } = setup({ failReload: true });
    // Seed a known-good prior conf for this slug.
    files.set(`${SITES}/app-example-com.conf`, "# PRIOR GOOD CONFIG");
    await expect(nginx.registerRoute(PROXY)).rejects.toThrow();
    // Rolled back — the bad block did not persist.
    expect(conf("app-example-com")).toBe("# PRIOR GOOD CONFIG");
  });
});

describe("renderProxyOptions (curated reverse-proxy directives)", () => {
  test("empty / undefined → no directives", () => {
    expect(renderProxyOptions(undefined)).toBe("");
    expect(renderProxyOptions({})).toBe("");
  });

  test("renders each valid directive", () => {
    const out = renderProxyOptions({
      clientMaxBodySize: "25m",
      proxyReadTimeout: "60s",
      proxySendTimeout: "60s",
      clientBodyTimeout: "30s",
      proxyBuffering: false,
    });
    expect(out).toContain("client_max_body_size 25m;");
    expect(out).toContain("proxy_read_timeout 60s;");
    expect(out).toContain("proxy_send_timeout 60s;");
    expect(out).toContain("client_body_timeout 30s;");
    expect(out).toContain("proxy_buffering off;");
  });

  test("gzip on → emits the FIXED type set (never user input)", () => {
    const out = renderProxyOptions({ gzip: true });
    expect(out).toContain("gzip on;");
    expect(out).toContain(`gzip_types ${PROXY_GZIP_TYPES};`);
    expect(out).toContain("gzip_min_length 1024;");
    expect(renderProxyOptions({ gzip: false })).toContain("gzip off;");
    expect(renderProxyOptions({ gzip: false })).not.toContain("gzip_types");
  });

  test("DROPS malformed values (injection / bad-value guard)", () => {
    const out = renderProxyOptions({
      // all invalid: injection attempt, wrong unit, non-positive, junk
      clientMaxBodySize: "25m; add_header X-Evil 1",
      proxyReadTimeout: "60x",
      proxySendTimeout: "0s",
    } as never);
    expect(out).toBe("");
    expect(out).not.toContain("add_header");
  });
});

describe("registerRoute renders proxy directives at server scope", () => {
  test("route.proxy → directive present in the generated vhost", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...PROXY, proxy: { clientMaxBodySize: "50m" } });
    const c = conf("app-example-com")!;
    expect(c).toContain("client_max_body_size 50m;");
    // server scope, not inside a location block
    expect(c).toContain("listen 443 ssl;");
  });

  test("no route.proxy → no body-size directive (inherits server default)", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(PROXY);
    expect(conf("app-example-com")!).not.toContain("client_max_body_size");
  });
});

// Security: an HTTPS request whose SNI matches no vhost must NOT fall through to
// the first-loaded 443 server block (cross-serving another app's cert+backend).
// The default catch-all owns `443 ssl default_server` and rejects unknown SNI.
describe("default catch-all rejects unmatched HTTPS hosts", () => {
  test("ensureOpenRestyConfig writes a 443 default_server that rejects unknown SNI", async () => {
    const files = new Map<string, string>();
    const calls: string[] = [];
    // nginx.conf already present → exercises the steady-state path (not bootstrap).
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    await ensureOpenRestyConfig(makeExecutor(files, {}, calls), PATHS);
    const def = files.get(`${SITES}/_default.conf`);
    expect(def).toBeDefined();
    expect(def).toContain("listen 443 ssl default_server;");
    expect(def).toContain("ssl_reject_handshake on;");
    // and the HTTP catch-all stays a default_server too (no fallthrough on :80).
    expect(def).toContain("listen 80 default_server;");
  });

  test("catch-all is re-written on every ensure (self-heals a stale 80-only copy)", async () => {
    const files = new Map<string, string>();
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    // Simulate an already-deployed box whose _default.conf predates the 443 reject.
    files.set(`${SITES}/_default.conf`, "server {\n    listen 80 default_server;\n}\n");
    await ensureOpenRestyConfig(makeExecutor(files, {}, []), PATHS);
    expect(files.get(`${SITES}/_default.conf`)).toContain("ssl_reject_handshake on;");
  });
});
