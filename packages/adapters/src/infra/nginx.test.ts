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

// A canonical host redirect (`www.example.com` → `example.com`, or an old domain
// → a new one). The redirecting host serves NO content of its own, but it is still
// an ordinary domain: it needs its own certificate, and it still has to be able to
// answer the ACME challenge that issues it.
describe("canonical host redirect", () => {
  const REDIRECT: RouteConfig = {
    ...OURS,
    domain: "www.example.com",
    redirectHost: { target: "example.com", statusCode: 301 },
  };
  const wwwConf = (conf: (slug: string) => string | undefined) => conf("www-example-com")!;

  test("replaces the upstream in BOTH the :80 and :443 blocks", async () => {
    const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
    await nginx.registerRoute(REDIRECT);
    const c = wwwConf(conf);
    const http = c.slice(c.indexOf("listen 80;"), c.indexOf("listen 443 ssl;"));
    const https = c.slice(c.indexOf("listen 443 ssl;"));
    for (const block of [http, https]) {
      expect(block).toContain("return 301 https://example.com$request_uri;");
      expect(block).not.toContain("proxy_pass http://127.0.0.1:3009;");
    }
  });

  test("goes STRAIGHT to the target from :80 — no bounce through our own https", async () => {
    // The destination is a different host, so there's no Flexible-CDN loop to dodge
    // and the conditional self-redirect would only cost an extra round trip.
    const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
    await nginx.registerRoute(REDIRECT);
    const http = wwwConf(conf).split("listen 443 ssl;")[0];
    expect(http).not.toContain("return 301 https://$server_name$request_uri;");
    expect(http).toContain("return 301 https://example.com$request_uri;");
  });

  test("$request_uri is preserved, so a deep link keeps its path AND query", async () => {
    const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
    await nginx.registerRoute(REDIRECT);
    expect(wwwConf(conf)).toContain("https://example.com$request_uri;");
  });

  test("KEEPS the ACME challenge location — it issues its own certificate", async () => {
    // Without this the redirect would answer certbot's HTTP-01 with a 301 and the
    // host could never get the cert its own `https://` redirect depends on.
    const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
    await nginx.registerRoute(REDIRECT);
    const c = wwwConf(conf);
    expect(c).toContain("location /.well-known/acme-challenge/");
    expect(c).toContain(`proxy_pass http://127.0.0.1:${ACME_HTTP01_PORT}`);
  });

  test("still gets a :443 listener before its real cert exists (bootstrap TLS)", async () => {
    // Same reason as any other locally-terminated host: no listener means the origin
    // refuses the handshake (Cloudflare 525) and issuance deadlocks.
    const { nginx, conf } = setup();
    await nginx.registerRoute(REDIRECT);
    expect(wwwConf(conf)).toContain("listen 443 ssl;");
  });

  test("honours the other redirect codes, and falls back to 301 for a non-redirect", async () => {
    for (const [status, expected] of [[302, 302], [308, 308], [200, 301]] as const) {
      const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
      await nginx.registerRoute({
        ...REDIRECT,
        redirectHost: { target: "example.com", statusCode: status },
      });
      expect(wwwConf(conf)).toContain(`return ${expected} https://example.com$request_uri;`);
    }
  });

  test("DROPS path locations, header rules and the webhook proxy", async () => {
    // A host where some paths redirect and others proxy is a split-brain vhost, and
    // a 30x would lose a webhook delivery's POST body.
    const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
    await nginx.registerRoute({
      ...REDIRECT,
      proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://127.0.0.1:4001" }],
      redirects: [{ path: "/old", exact: true, statusCode: 302, destination: "/new" }],
      headerRules: [{ path: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      webhookProxy: "http://127.0.0.1:4000/api/webhooks/",
    });
    const c = wwwConf(conf);
    expect(c).not.toContain("location /api/");
    expect(c).not.toContain("location = /old");
    expect(c).not.toContain("X-Frame-Options");
    expect(c).not.toContain("/_openship/hooks/");
  });

  test("REFUSES an injection-shaped target instead of interpolating it", async () => {
    // The target lands in the emitted config, so it gets the same validation the
    // route's own domain does — an API-side check is not the last line of defence.
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({
        ...OURS,
        domain: "www.example.com",
        redirectHost: { target: "example.com;\n return 301 http://evil.test", statusCode: 301 },
      }),
    ).rejects.toThrow();
  });

  test("survives cert re-registration — the route sidecar carries the redirect", async () => {
    // provisionCert re-registers from the persisted RouteConfig to add the TLS
    // block; a redirect dropped there would silently start serving the app again.
    const { nginx, conf, files } = setup();
    await nginx.registerRoute(REDIRECT);
    const sidecar = [...files.entries()].find(([p]) => p.includes("www-example-com") && p.endsWith(".json"));
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar![1]).redirectHost).toEqual({
      target: "example.com",
      statusCode: 301,
    });
    // Re-register the way provisionCert does, now WITH a cert on disk.
    const saved = JSON.parse(sidecar![1]) as RouteConfig;
    const withCert = setup({ certDomains: ["www.example.com"] });
    await withCert.nginx.registerRoute({ ...saved, domain: "www.example.com", tls: true });
    const reissued = wwwConf(withCert.conf);
    expect(reissued).toContain("listen 443 ssl;");
    expect(reissued).toContain("return 301 https://example.com$request_uri;");
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

/**
 * SLUG COLLISIONS.
 *
 * `domainSlug` folds every non-alphanumeric to `-`, so a dot and a literal dash
 * collapse together and two different hostnames land on one filename:
 *
 *     staging.app.example.com  ->  staging-app-example-com
 *     staging-app.example.com  ->  staging-app-example-com
 *
 * Both are ordinary hostnames, separately claimable, and can belong to different
 * projects or orgs (one edge fronts the whole box). Before `resolveSlug` the
 * second registration silently overwrote the first's vhost — the loser's traffic
 * fell through to `default_server`, a silent outage of someone else's domain —
 * and `removeRoute` on either deleted the shared file and took out both.
 */
describe("slug collisions between dotted and dashed hostnames", () => {
  const DOTTED = "staging.app.example.com";
  const DASHED = "staging-app.example.com";
  const BASE = "staging-app-example-com";

  const route = (domain: string, port: number): RouteConfig => ({
    domain,
    tls: false,
    targetUrl: `http://127.0.0.1:${port}`,
  });

  /** Every vhost conf currently on disk. */
  const confs = (files: Map<string, string>) =>
    [...files.keys()].filter((p) => p.startsWith(`${SITES}/`) && p.endsWith(".conf"));

  const confFor = (files: Map<string, string>, domain: string) =>
    confs(files).filter((p) => (files.get(p) ?? "").includes(`server_name ${domain};`));

  test("the second hostname does NOT overwrite the first — each gets its own file", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(route(DOTTED, 3001));
    await nginx.registerRoute(route(DASHED, 3002));

    expect(confs(files)).toHaveLength(2);
    // Each hostname is served by exactly one file, with its own upstream.
    expect(confFor(files, DOTTED)).toHaveLength(1);
    expect(confFor(files, DASHED)).toHaveLength(1);
    expect(files.get(confFor(files, DOTTED)[0]!)).toContain("127.0.0.1:3001");
    expect(files.get(confFor(files, DASHED)[0]!)).toContain("127.0.0.1:3002");
  });

  test("the incumbent keeps the base filename; the newcomer is the one disambiguated", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(route(DOTTED, 3001));
    await nginx.registerRoute(route(DASHED, 3002));

    expect(confFor(files, DOTTED)[0]).toBe(`${SITES}/${BASE}.conf`);
    expect(confFor(files, DASHED)[0]).not.toBe(`${SITES}/${BASE}.conf`);
  });

  test("re-registering the newcomer is stable — no third file, no move", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(route(DOTTED, 3001));
    await nginx.registerRoute(route(DASHED, 3002));
    const before = confFor(files, DASHED)[0];

    await nginx.registerRoute(route(DASHED, 3003));
    expect(confs(files)).toHaveLength(2);
    expect(confFor(files, DASHED)[0]).toBe(before);
    expect(files.get(before!)).toContain("127.0.0.1:3003");
  });

  test("removing one does not take the other down", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(route(DOTTED, 3001));
    await nginx.registerRoute(route(DASHED, 3002));

    await nginx.removeRoute(DASHED);
    expect(confFor(files, DASHED)).toHaveLength(0);
    // The incumbent survives — this is what the shared file used to destroy.
    expect(confFor(files, DOTTED)).toHaveLength(1);
    expect(files.get(confFor(files, DOTTED)[0]!)).toContain("127.0.0.1:3001");
  });

  test("removing the incumbent does not take the newcomer down", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(route(DOTTED, 3001));
    await nginx.registerRoute(route(DASHED, 3002));

    await nginx.removeRoute(DOTTED);
    expect(confFor(files, DOTTED)).toHaveLength(0);
    expect(confFor(files, DASHED)).toHaveLength(1);
  });

  /**
   * The ordering argument for `resolveSlug`. Once a hostname owns a suffixed file
   * it must KEEP it: if freeing the base name let it migrate, the old suffixed
   * conf would stay on disk still answering for the same hostname — two vhosts for
   * one name, which is precisely the orphan class this is meant to prevent.
   */
  test("keeps its own file after the incumbent is removed, rather than migrating and orphaning", async () => {
    const { nginx, files } = setup();
    await nginx.registerRoute(route(DOTTED, 3001));
    await nginx.registerRoute(route(DASHED, 3002));
    const own = confFor(files, DASHED)[0];

    await nginx.removeRoute(DOTTED);
    await nginx.registerRoute(route(DASHED, 3004));

    expect(confFor(files, DASHED)).toHaveLength(1);
    expect(confFor(files, DASHED)[0]).toBe(own);
    expect(confs(files)).toHaveLength(1);
  });

  test("an ordinary hostname still uses the plain slug — naming is unchanged", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(route("solo.example.com", 3005));
    expect(conf("solo-example-com")).toContain("server_name solo.example.com;");
  });

  /**
   * An ADOPTED vhost can list several hostnames in one `server_name`. Registering
   * one of them must reuse that file, not add a second vhost answering the same
   * name (nginx would warn about the conflict and silently prefer one).
   */
  test("reuses a multi-hostname vhost that already lists this domain", async () => {
    const { nginx, files } = setup();
    files.set(
      `${SITES}/${BASE}.conf`,
      `server {\n  listen 80;\n  server_name ${DOTTED} ${DASHED};\n}\n`,
    );

    await nginx.registerRoute(route(DASHED, 3006));
    expect(confs(files)).toHaveLength(1);
    expect(files.get(`${SITES}/${BASE}.conf`)).toContain("127.0.0.1:3006");
  });
});
