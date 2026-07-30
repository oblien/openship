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
  /** Simulate an edge with no `openssl` CLI (bootstrap cert can't be produced). */
  noOpenssl?: boolean;
}

/** Stateful fake executor: in-memory file map + atomic-rename (`mv`) handling.
 *  Detection commands throw so reload() keeps the cached sitesDir. */
function makeExecutor(
  files: Map<string, string>,
  opts: FakeOpts,
  calls: string[],
  removed: string[] = [],
): CommandExecutor {
  const exec = async (command: string): Promise<string> => {
    calls.push(command);
    // openresty path detection (reload re-detects) → fail so cached paths stick.
    if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
    if (command.startsWith("openssl ")) {
      if (opts.noOpenssl) throw new Error("openssl: not found");
      // Real openssl writes the pair; the fake just records the two staged paths so
      // the `mv` below has something to move.
      for (const m of command.matchAll(/'([^']*\.pem)'/g)) files.set(m[1], "PEM");
      return "";
    }
    if (command.startsWith("mv -f ")) {
      // Pair swap: `mv -f 'staging/fullchain.pem' 'staging/privkey.pem' 'dir'/`
      const paths = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const dir = paths.pop()!;
      for (const src of paths) {
        const c = files.get(src);
        if (c !== undefined) { files.set(`${dir}/${src.split("/").pop()}`, c); files.delete(src); }
      }
      return "";
    }
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
    rm: async (p: string) => { removed.push(p); files.delete(p); },
  } as unknown as CommandExecutor;
}

function setup(opts: FakeOpts = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const removed: string[] = [];
  const nginx = new NginxProvider({ paths: PATHS, executor: makeExecutor(files, opts, calls, removed) });
  return { nginx, files, calls, removed, conf: (slug: string) => files.get(`${SITES}/${slug}.conf`) };
}

const PROXY: RouteConfig = { domain: "app.example.com", tls: true, targetUrl: "http://127.0.0.1:3009" };
/** Same route, flagged as one whose TLS this box terminates (a custom domain). */
const OURS: RouteConfig = { ...PROXY, terminatesTlsLocally: true };
const BOOTSTRAP_DIR = "/etc/letsencrypt/openship-bootstrap/app.example.com";

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
    await nginx.registerRoute({
      domain: "site.example.com",
      tls: false,
      staticRoot: "/opt/openship/static/site/dist",
    });
    const c = conf("site-example-com")!;
    expect(c).toContain("root /opt/openship/static/site/dist;");
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

  test("a domain we terminate TLS for gets a :443 listener BEFORE its cert exists", async () => {
    const { nginx, conf } = setup(); // no cert yet
    await nginx.registerRoute(OURS);
    const c = conf("app-example-com")!;
    // The whole point of #308: without this block an HTTPS request for a domain we
    // DO route falls through to the edge's `ssl_reject_handshake` default, so the
    // origin refuses the handshake — Cloudflare reports that as error 525, and the
    // ACME challenge it redirects to HTTPS fails for the same reason, forever.
    expect(c).toContain("listen 443 ssl;");
    expect(c).toContain(`ssl_certificate ${BOOTSTRAP_DIR}/fullchain.pem;`);
    expect(c).toContain(`ssl_certificate_key ${BOOTSTRAP_DIR}/privkey.pem;`);
    // Placeholder state is legible on the box.
    expect(c).toContain("openship-bootstrap-tls");
    // :80 must keep SERVING: plain HTTP answers the ACME challenge, and pushing a
    // browser onto an untrusted cert is worse than serving HTTP.
    expect(c).not.toContain("return 301 https://");
    expect(c).toContain("location /.well-known/acme-challenge/");
    // Both blocks are name-bound, so unknown SNI still hits the reject-handshake
    // default — no cross-serving regression.
    expect(c.match(/server_name app\.example\.com;/g)?.length).toBe(2);
  });

  test("the placeholder cert is NOT written to certbot's live/ tree", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(OURS);
    // Putting it in live/ would make certsExist() true → provisionCert short-circuits
    // and an untrusted cert is reported as `active`, with renewal satisfied.
    expect([...files.keys()].some((p) => p.startsWith("/etc/letsencrypt/live/"))).toBe(false);
    expect(files.get(`${BOOTSTRAP_DIR}/fullchain.pem`)).toBe("PEM");
  });

  test("no openssl on the edge → HTTP-only, deploy still succeeds", async () => {
    const { nginx, conf } = setup({ noOpenssl: true });
    await nginx.registerRoute(OURS); // must not throw
    const c = conf("app-example-com")!;
    expect(c).not.toContain("listen 443 ssl;");
    expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
  });

  test("a host whose TLS is NOT ours never gets a placeholder cert", async () => {
    const { nginx, conf, calls } = setup();
    // externalIngress / managed *.opsh.io: TLS terminates elsewhere, so presenting
    // a self-signed cert for the name would be wrong, not merely unnecessary.
    await nginx.registerRoute({ ...PROXY, terminatesTlsLocally: false });
    expect(conf("app-example-com")!).not.toContain("listen 443 ssl;");
    expect(calls.some((c) => c.startsWith("openssl "))).toBe(false);
  });

  test("a host that STOPS terminating TLS here drops its placeholder", async () => {
    // Cleanup keys off what was emitted, not off "a real cert arrived", so a route
    // re-registered without the flag (external ingress adopted later, or a caller
    // that claimed it too broadly) converges instead of leaving a stale :443
    // listener and stale key material behind.
    const { nginx, removed } = setup();
    await nginx.registerRoute(OURS);
    expect(removed).not.toContain(BOOTSTRAP_DIR);
    await nginx.registerRoute({ ...PROXY, terminatesTlsLocally: false });
    expect(removed).toContain(BOOTSTRAP_DIR);
  });

  test("the real cert supersedes the placeholder and deletes it", async () => {
    const { nginx, conf, removed } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(OURS);
    const c = conf("app-example-com")!;
    expect(c).toContain("ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;");
    expect(c).not.toContain("openship-bootstrap");
    // Removed only AFTER the reload — until the new conf is live, OpenResty is
    // still reading the placeholder paths.
    expect(removed).toContain(BOOTSTRAP_DIR);
  });

  test("removeRoute cleans up the placeholder cert", async () => {
    const { nginx, removed } = setup();
    await nginx.registerRoute(OURS);
    await nginx.removeRoute("app.example.com");
    expect(removed).toContain(BOOTSTRAP_DIR);
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

// A CDN in front of us may terminate TLS and reach origin on plain :80
// (Cloudflare's "Flexible" mode). Two things must hold there.
describe("behind a TLS-terminating CDN", () => {
  test("the :80 redirect is conditional, so a CDN-terminated request can't loop", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(OURS);
    const c = conf("app-example-com")!;
    // Unconditional `301 → https` on :80 sends the request back to the CDN, which
    // comes back here on :80: an infinite redirect loop.
    expect(c).toContain('if ($http_x_forwarded_proto = "https")');
    expect(c).toContain("set $openship_redirect_https 0;");
    expect(c).toContain("if ($openship_redirect_https) {");
    expect(c).toContain("return 301 https://$server_name$request_uri;");
    // …and when it does NOT redirect, :80 has to be able to serve — including the
    // rules guard, so rate limits / bans aren't bypassable by arriving on :80.
    const http = c.slice(c.indexOf("listen 80;"), c.indexOf("listen 443 ssl;"));
    expect(http).toContain("proxy_pass http://127.0.0.1:3009;");
    if (luaSourceAvailable()) expect(http).toContain(`access_by_lua_file ${RULES_GUARD_PATH};`);
  });

  test("the CDN's X-Forwarded-Proto is forwarded, not overwritten with $scheme", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(OURS);
    const c = conf("app-example-com")!;
    // `$scheme` reads "http" for a request the browser made over https, which breaks
    // app-generated absolute URLs, secure cookies, and framework HTTPS guards.
    expect(c).toContain("proxy_set_header X-Forwarded-Proto $openship_fwd_proto;");
    expect(c).not.toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    // Falls back to $scheme when no CDN set the header.
    expect(c).toContain("set $openship_fwd_proto $scheme;");
    // Only an exact "https" is honoured, and the LITERAL is forwarded — never the
    // client's own string, which is legally a list ("http, https") behind chained
    // proxies and would confuse a framework comparing it to "https".
    expect(c).toContain("set $openship_fwd_proto https;");
    expect(c).not.toContain("set $openship_fwd_proto $http_x_forwarded_proto;");
  });

  test("every block that sends the header also defines the variable", async () => {
    // A vhost referencing an undefined variable fails `openresty -t`, which means
    // the reload is refused and registerRoute rolls the route back — so the two must
    // never drift apart. Built-in variables only, deliberately: no http-level `map`
    // an already-deployed edge image wouldn't have.
    for (const opts of [{}, { certDomains: ["app.example.com"] }]) {
      const { nginx, conf } = setup(opts);
      await nginx.registerRoute({ ...OURS, webhookProxy: "http://127.0.0.1:4000/api/webhooks/" });
      const c = conf("app-example-com")!;
      const blocks = c.split(/^server \{$/m).slice(1);
      for (const block of blocks) {
        if (block.includes("$openship_fwd_proto")) {
          expect(block).toContain("set $openship_fwd_proto $scheme;");
        }
      }
    }
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

describe("static root confinement", () => {
  test("refuses a managed root outside /opt/openship", async () => {
    const { nginx } = setup();
    // The whole point: a route we generate must not be able to publish an arbitrary
    // host directory. Fails closed rather than serving it.
    await expect(
      nginx.registerRoute({ domain: "evil.example.com", tls: false, staticRoot: "/etc" }),
    ).rejects.toThrow(/Refusing to serve static root outside/);
  });

  test("prefix alone is not enough — a sibling dir cannot pose as a child", async () => {
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({
        domain: "evil.example.com",
        tls: false,
        staticRoot: "/opt/openship-evil/dist",
      }),
    ).rejects.toThrow(/Refusing to serve static root outside/);
  });

  test("allows an ADOPTED root outside the base (proxy migration)", async () => {
    const { nginx, conf } = setup();
    // An imported vhost's root is already public on the operator's own nginx;
    // refusing it would break taking that proxy over.
    await nginx.registerRoute({
      domain: "legacy.example.com",
      tls: false,
      staticRoot: "/var/www/legacy",
      staticRootAdopted: true,
    });
    expect(conf("legacy-example-com")).toContain("root /var/www/legacy;");
  });

  test("still refuses traversal and injection even when adopted", async () => {
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({
        domain: "x.example.com",
        tls: false,
        staticRoot: "/var/www/../../etc",
        staticRootAdopted: true,
      }),
    ).rejects.toThrow(/must be an absolute path, no traversal/);
  });
});
