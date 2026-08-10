import { describe, expect, test } from "vitest";
import {
  NginxProvider,
  renderProxyOptions,
  renderProxyTlsOptions,
  type NginxProviderOptions,
} from "./nginx";
import {
  PROXY_DIRECTIVES,
  PROXY_GZIP_TYPES,
  expectedProxyState,
  type ProxyDirectiveSpec,
  type ProxySettings,
} from "@repo/core";
import { scanOpenshipEdge } from "../system/proxy/import/nginx";
import { OPENRESTY_DEFAULT_PATHS, luaSourceAvailable, RULES_GUARD_PATH, ACME_HTTP01_PORT, EDGE_CHALLENGE_DIR, EDGE_CHALLENGE_ROOT, EDGE_CHALLENGE_URL_PREFIX, ensureOpenRestyConfig, edgeDefaultCertPaths } from "./openresty-lua";
import { EDGE_NOT_FOUND_HTML } from "./edge-not-found";
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
  provider?: Partial<NginxProviderOptions>;
  certbotFailure?: string;
}

/** Stateful fake executor: in-memory file map + atomic-rename (`mv`) handling.
 *  Detection commands throw so reload() keeps the cached sitesDir. */
function makeExecutor(
  files: Map<string, string>,
  opts: FakeOpts,
  calls: string[],
  removed: string[] = [],
  writes: Array<{ path: string; content: string }> = [],
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
    if ((command.startsWith("certbot ") || command.startsWith("env ")) && opts.certbotFailure) {
      throw new Error(opts.certbotFailure);
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
    writeFile: async (p: string, c: string) => { writes.push({ path: p, content: c }); files.set(p, c); },
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
  const writes: Array<{ path: string; content: string }> = [];
  const nginx = new NginxProvider({
    ...opts.provider,
    paths: PATHS,
    executor: makeExecutor(files, opts, calls, removed, writes),
  });
  return { nginx, files, calls, removed, writes, conf: (slug: string) => files.get(`${SITES}/${slug}.conf`) };
}

const PROXY: RouteConfig = { domain: "app.example.com", tls: true, targetUrl: "http://127.0.0.1:3009" };
/** Same route, flagged as one whose TLS this box terminates (a custom domain). */
const OURS: RouteConfig = { ...PROXY, terminatesTlsLocally: true };
const BOOTSTRAP_DIR = "/etc/letsencrypt/openship-bootstrap/app.example.com";

/**
 * Openship Cloud's shared edge proves this box controls a routing target by fetching
 * a token over plain HTTP from the target. Every `:80` shape must answer it, because
 * any of them can be the vhost the probe lands on — and a `:443` block must NOT,
 * since the target is always schemed `http://`. The 443 catch-all is not an
 * exception: it answers unmatched SNI with the "service not found" page and carries
 * no challenge location, so an HTTPS probe there is a 404, never a proxied request.
 *
 * The location must also out-prefix `location /`: without it, a probe for a hostname
 * target served by a TENANT's app would be proxied INTO that app, which could then
 * echo back any token and prove control of this box as its own routing target.
 */
describe("NginxProvider edge-target challenge location", () => {
  const hasChallenge = (c: string) => c.includes(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);

  test("is emitted in the HTTP-only shape (no cert yet)", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(hasChallenge(c)).toBe(true);
    expect(c).toContain(`root ${EDGE_CHALLENGE_ROOT};`);
    // Files only — never an echo of whatever token the URL carried.
    expect(c).toContain("try_files $uri =404;");
  });

  test("is emitted in the cert-present shape, on :80 ONLY", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    const [httpBlock, tlsBlock] = c.split("listen 443 ssl;");
    expect(hasChallenge(httpBlock!)).toBe(true);
    expect(hasChallenge(tlsBlock ?? "")).toBe(false);
  });

  test("is emitted in the bootstrap-TLS shape, on :80 ONLY", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(OURS);
    const c = conf("app-example-com")!;
    expect(c).toContain("openship-bootstrap-tls:");
    const [httpBlock, tlsBlock] = c.split("listen 443 ssl;");
    expect(hasChallenge(httpBlock!)).toBe(true);
    expect(hasChallenge(tlsBlock ?? "")).toBe(false);
  });

  test("precedes `location /` so the longest-prefix match wins", async () => {
    // nginx picks the longest matching prefix regardless of order, but emitting it
    // first keeps the generated file readable and matches the ACME slot.
    const { nginx, conf } = setup();
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(c.indexOf(EDGE_CHALLENGE_URL_PREFIX)).toBeLessThan(c.indexOf("location / {"));
  });
});

describe("NginxProvider.serveEdgeChallenge", () => {
  const CHALLENGE = `${SITES}/_oblien-challenge-203-0-113-10.conf`;

  test("with NO tokens, still writes the vhost — the box is ready before any challenge", async () => {
    // The whole point of the proactive form. The location serves a DIRECTORY, so it is
    // valid with nothing in it (a missing token 404s, which is the right answer), and
    // this vhost lands in the bind-mounted sites-enabled written by our own code — so
    // it works on any edge image, including one predating this feature or a rollback.
    const { nginx, files } = setup();
    const r = await nginx.serveEdgeChallenge({ host: "203.0.113.10" });

    expect(r).toMatchObject({ served: true, via: "challenge-vhost" });
    expect(files.get(CHALLENGE)).toContain(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);
    // No token files yet — nothing has been issued.
    expect([...files.keys()].some((k) => k.startsWith(EDGE_CHALLENGE_DIR))).toBe(false);
  });

  test("a later token write reuses the existing vhost without a second reload", async () => {
    // The two call forms in sequence: ensure at deploy, then serve at verify time.
    const { nginx, files, calls } = setup();
    await nginx.serveEdgeChallenge({ host: "203.0.113.10" });
    const reloads = calls.filter((c) => c.includes("-s reload")).length;

    const r = await nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] });

    expect(r).toMatchObject({ served: true, via: "challenge-vhost" });
    expect(files.get(`${EDGE_CHALLENGE_DIR}/tok-abcdef123456`)).toBe("tok-abcdef123456");
    expect(calls.filter((c) => c.includes("-s reload")).length).toBe(reloads);
  });

  test("writes each token as a FILE named after itself", async () => {
    const { nginx, files } = setup();
    await nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] });
    // The body must be the token verbatim — Oblien compares after trimming.
    expect(files.get(`${EDGE_CHALLENGE_DIR}/tok-abcdef123456`)).toBe("tok-abcdef123456");
  });

  test("serves several tokens at once (re-issue + multi-org on one box)", async () => {
    const { nginx, files } = setup();
    await nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-aaaaaaaaaaaa", "tok-bbbbbbbbbbbb"] });
    expect(files.get(`${EDGE_CHALLENGE_DIR}/tok-aaaaaaaaaaaa`)).toBeDefined();
    expect(files.get(`${EDGE_CHALLENGE_DIR}/tok-bbbbbbbbbbbb`)).toBeDefined();
  });

  test("writes a challenge vhost keyed on the host, serving the not-found page at /", async () => {
    // This vhost claims a `server_name` — the box's own IP, in production — and a named
    // server beats the catch-all for EVERY URI of that host, not just the challenge
    // one. With no `location /` nginx fell through to its compiled-in `root html`, so
    // visiting the box by IP got OpenResty's 128 KB welcome page with the version
    // banner: the direct-IP half of #431, on the one vhost the catch-all can't cover.
    //
    // It carries `location /` rather than dropping the server_name because the vhost's
    // whole purpose is to answer for that host. Keeping the proxy scanner from reading
    // the result as a static site rooted at the challenge dir is the other half, and
    // it lives in openship-edge-scan.test.ts against these same bytes.
    const { nginx, files } = setup();
    const r = await nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] });
    expect(r).toMatchObject({ served: true, via: "challenge-vhost" });
    const c = files.get(CHALLENGE)!;
    expect(c).toContain("server_name 203.0.113.10;");
    expect(c).toContain(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);
    expect(c).toContain("location / {");
    expect(c).toContain("Service not found");
    // Still a dead end: nothing here may reach a backend or serve a doc root at /.
    expect(c).not.toContain("proxy_pass");
    // Never a default_server: sanitizeEdgeVhosts sed-strips those on every start.
    expect(c).not.toContain("default_server");
  });

  test("is idempotent — a second identical call neither rewrites nor reloads", async () => {
    const { nginx, calls, files } = setup();
    await nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] });
    const reloadsAfterFirst = calls.filter((c) => c.includes("reload") || c.includes("openresty")).length;
    files.delete(`${EDGE_CHALLENGE_DIR}/tok-abcdef123456`); // prove the token is re-asserted
    const r = await nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] });
    expect(r).toMatchObject({ served: true, via: "challenge-vhost" });
    expect(files.get(`${EDGE_CHALLENGE_DIR}/tok-abcdef123456`)).toBe("tok-abcdef123456");
    const reloadsAfterSecond = calls.filter((c) => c.includes("reload") || c.includes("openresty")).length;
    expect(reloadsAfterSecond).toBe(reloadsAfterFirst);
  });

  test("defers to an existing vhost that already claims the host", async () => {
    // Writing a second vhost for the same server_name would be actively harmful:
    // nginx only WARNS on a conflict (so `-t` passes and no rollback fires) and then
    // serves whichever loaded first — `_` sorts before lowercase, so ours would win
    // and reduce the real site to 404s.
    const { nginx, files } = setup();
    await nginx.registerRoute(PROXY);
    const before = files.get(`${SITES}/app-example-com.conf`);
    const r = await nginx.serveEdgeChallenge({ host: "app.example.com", tokens: ["tok-abcdef123456"] });
    expect(r).toMatchObject({ served: true, via: "existing-vhost" });
    expect(files.get(`${SITES}/_oblien-challenge-app-example-com.conf`)).toBeUndefined();
    expect(files.get(`${SITES}/app-example-com.conf`)).toBe(before); // untouched
  });

  test("refuses (with the file named) when a STALE vhost claims the host", async () => {
    const { nginx, files } = setup();
    // A vhost from before challenge support: claims the host, has no challenge location.
    files.set(`${SITES}/legacy-example-com.conf`, "server {\n    server_name legacy.example.com;\n}\n");
    const r = await nginx.serveEdgeChallenge({ host: "legacy.example.com", tokens: ["tok-abcdef123456"] });
    expect(r.served).toBe(false);
    expect(r.claimedBy).toContain("legacy-example-com.conf");
    expect(r.reason).toMatch(/Re-register/);
  });

  test("rejects a token that would escape the challenge directory", async () => {
    // The token becomes a FILENAME, so this is stricter than the nginx-syntax guard:
    // neither `/` nor `..` contains a character nginx would object to.
    const { nginx } = setup();
    for (const bad of ["../../etc/passwd", "a/b", "sh ort", ""]) {
      await expect(
        nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: [bad] }),
      ).rejects.toThrow(/challenge token/);
    }
  });

  test("rolls back the vhost when the reload fails", async () => {
    const { nginx, files } = setup({ failReload: true });
    await expect(
      nginx.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] }),
    ).rejects.toThrow();
    expect(files.get(CHALLENGE)).toBeUndefined();
  });
});

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

  test("alternate ACME directory, CA bundle, and key type reach certbot", async () => {
    const { nginx, calls } = setup({
      provider: {
        acmeDirectoryUrl: "https://acme.example.test/directory",
        acmeCaBundle: "/etc/ssl/private/acme-root.pem",
        acmeKeyType: "ec384",
      },
    });
    await expect(nginx.provisionCert("app.example.com")).rejects.toThrow();
    const certbot = calls.find((c) => c.startsWith("env ") && c.includes("certbot"));
    expect(certbot).toContain("REQUESTS_CA_BUNDLE=/etc/ssl/private/acme-root.pem");
    expect(certbot).toContain("--server");
    expect(certbot).toContain("https://acme.example.test/directory");
    expect(certbot).toContain("--key-type");
    expect(certbot).toContain("ecdsa");
    expect(certbot).toContain("secp384r1");
  });

  test("EAB HMAC is passed through an ephemeral 0600 config and never argv or errors", async () => {
    const hmac = "c3VwZXItc2VjcmV0LWhtYWM";
    const { nginx, calls, writes, removed } = setup({
      provider: { acmeEabKid: "kid-123", acmeEabHmacKey: hmac },
      certbotFailure: `CA rejected EAB key ${hmac}`,
    });
    let error: Error | undefined;
    try {
      await nginx.provisionCert("app.example.com");
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(hmac);
    expect(error?.message).toContain("[REDACTED]");

    const secretWrite = writes.find((w) => w.path.includes(".openship-eab-"));
    expect(secretWrite?.content).toContain("eab-kid = kid-123");
    expect(secretWrite?.content).toContain(`eab-hmac-key = ${hmac}`);
    const certbot = calls.find((c) => c.startsWith("certbot "));
    expect(certbot).toContain("--config");
    expect(certbot).not.toContain(hmac);
    const configPath = certbot?.match(/'--config' '([^']+)'/)?.[1];
    expect(configPath).toBeDefined();
    // git-ssh-material layout: the ini lives in its own 0700 directory (locked
    // down BEFORE any secret bytes land, covering even the staged temp file),
    // the file itself is chmod 600 before the rename publishes it, and cleanup
    // removes the whole directory as a unit.
    const secretDir = configPath!.replace(/\/eab\.ini$/, "");
    expect(secretDir).toContain(".openship-eab-");
    const dirChmodIdx = calls.findIndex((c) => c.startsWith("chmod ") && c.includes("'700'") && c.includes(secretDir));
    const fileChmodIdx = calls.findIndex((c) => c.startsWith("chmod ") && c.includes("'600'") && c.includes(`${configPath}.tmp-`));
    const publishIdx = calls.findIndex((c) => c.startsWith("mv ") && c.includes(`'${configPath}'`));
    expect(dirChmodIdx).toBeGreaterThanOrEqual(0);
    expect(fileChmodIdx).toBeGreaterThan(dirChmodIdx);
    expect(publishIdx).toBeGreaterThan(fileChmodIdx);
    expect(removed).toContain(secretDir);
  });

  test("rejects incomplete or malformed EAB configuration before issuance", () => {
    expect(() => setup({ provider: { acmeEabKid: "kid-only" } })).toThrow(/requires both/i);
    expect(() => setup({
      provider: { acmeEabKid: "kid", acmeEabHmacKey: "not standard base64/+" },
    })).toThrow(/base64url/i);
  });

  test("renewing a lineage issued by a DIFFERENT directory reissues under the configured CA", async () => {
    const { nginx, files, calls } = setup({
      certDomains: ["app.example.com"],
      provider: { acmeDirectoryUrl: "https://acme.example.test/directory" },
    });
    // Pre-switch lineage: certbot's renewal conf records the OLD issuing server,
    // which `renew` holds no account for after the operator changed CAs.
    files.set(
      "/etc/letsencrypt/renewal/app.example.com.conf",
      "[renewalparams]\nserver = https://acme-v02.api.letsencrypt.org/directory\n",
    );
    await nginx.renewCert("app.example.com").catch(() => undefined);
    const certonly = calls.find((c) => c.includes("certonly"));
    expect(certonly).toContain("--force-renewal");
    expect(certonly).toContain("--server");
    expect(certonly).toContain("https://acme.example.test/directory");
    expect(calls.find((c) => c.includes("'renew'"))).toBeUndefined();
  });

  test("renewing a lineage issued by the SAME directory renews plainly, without --server", async () => {
    const { nginx, files, calls } = setup({
      certDomains: ["app.example.com"],
      provider: { acmeDirectoryUrl: "https://acme.example.test/directory" },
    });
    files.set(
      "/etc/letsencrypt/renewal/app.example.com.conf",
      "[renewalparams]\nserver = https://acme.example.test/directory\n",
    );
    await nginx.renewCert("app.example.com").catch(() => undefined);
    const renew = calls.find((c) => c.startsWith("certbot ") && c.includes("'renew'"));
    expect(renew).toContain("--cert-name");
    expect(renew).not.toContain("--server");
    expect(calls.find((c) => c.includes("certonly"))).toBeUndefined();
  });

  test("a renew failure never leaks the EAB HMAC in the thrown error", async () => {
    const hmac = "c3VwZXItc2VjcmV0LWhtYWM";
    const { nginx, files } = setup({
      certDomains: ["app.example.com"],
      provider: { acmeEabKid: "kid-123", acmeEabHmacKey: hmac },
      certbotFailure: `CA rejected EAB key ${hmac}`,
    });
    // Matching lineage (no custom directory → certbot's Let's Encrypt default),
    // so the PLAIN renew path runs — the one with no redacting catch of its own.
    files.set(
      "/etc/letsencrypt/renewal/app.example.com.conf",
      "[renewalparams]\nserver = https://acme-v02.api.letsencrypt.org/directory\n",
    );
    let error: Error | undefined;
    try {
      await nginx.renewCert("app.example.com");
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(hmac);
    expect(error?.message).toContain("[REDACTED]");
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
    // DO route falls through to the edge's 443 catch-all, which is deliberately a
    // dead end — since #431 a placeholder cert and the "no application is configured"
    // page, and before it `ssl_reject_handshake`. Either way the domain never reaches
    // its backend, and an ACME challenge redirected to HTTPS fails there forever.
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

/* ── The curated tunables, driven by the table rather than a hand-listed set ──
 *
 * `PROXY_DIRECTIVES` in @repo/core is the one declaration of what exists; the type,
 * the API schema, this renderer, the config parser and the editor all derive from it.
 * The failure that matters is a row that reaches some of those and not others — a
 * setting that validates and saves and then never appears in a vhost. So these tests
 * iterate the table: a new row with no render form fails them without anyone
 * remembering to add a case.
 */

/** A valid value for a row, from its declared kind. */
function sampleFor(spec: ProxyDirectiveSpec): string | number | boolean {
  switch (spec.kind) {
    case "size":
      return "50m";
    case "time":
      return "300s";
    case "buffers":
      return "8 16k";
    case "int":
      return spec.min ?? 1;
    default:
      return true;
  }
}

/** Every directive set at once. */
const FULL_PROXY = Object.fromEntries(
  PROXY_DIRECTIVES.map((spec) => [spec.key, sampleFor(spec)]),
) as ProxySettings;

/** The `server { … }` bodies of a generated vhost, in file order. */
function serverBlocks(conf: string): string[] {
  return conf.split(/^server \{$/m).slice(1);
}

const httpBlock = (conf: string) => serverBlocks(conf).find((b) => b.includes("listen 80;"))!;
const tlsBlock = (conf: string) => serverBlocks(conf).find((b) => b.includes("listen 443 ssl;"))!;

/** Nesting depth at `index`; 0 = directly inside the `server { }` body. */
function braceDepthAt(block: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") depth--;
  }
  return depth;
}

describe("renderProxyOptions covers the whole directive table", () => {
  test("emits every row, exactly once, terminated and indented", () => {
    const out = `${renderProxyOptions(FULL_PROXY)}${renderProxyTlsOptions(FULL_PROXY)}`;
    for (const spec of PROXY_DIRECTIVES) {
      const line = `    ${spec.directive} ${
        spec.kind === "bool" ? "on" : String(sampleFor(spec))
      };`;
      expect(out, spec.key).toContain(line);
      // Emitted twice, nginx rejects the vhost and the site stops serving.
      expect(out.split(`\n    ${spec.directive} `).length - 1, spec.key).toBe(1);
    }
  });

  test("every emitted line is a single complete directive", () => {
    // The injection guard, restated on the output side: nothing we write may carry a
    // `;`, a brace or a newline inside its argument.
    const lines = `${renderProxyOptions(FULL_PROXY)}${renderProxyTlsOptions(FULL_PROXY)}`
      .split("\n")
      .filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(PROXY_DIRECTIVES.length - 1);
    for (const line of lines) {
      expect(line).toMatch(/^ {4}[a-z][a-z0-9_]* [^;{}]+;$/);
    }
  });

  test("keeps TLS-only directives out of the shared text", () => {
    const shared = renderProxyOptions(FULL_PROXY);
    const tls = renderProxyTlsOptions(FULL_PROXY);
    for (const spec of PROXY_DIRECTIVES.filter((d) => d.tlsOnly)) {
      expect(shared, spec.key).not.toContain(spec.directive);
      expect(tls, spec.key).toContain(spec.directive);
    }
    for (const spec of PROXY_DIRECTIVES.filter((d) => !d.tlsOnly)) {
      expect(tls, spec.key).not.toContain(`${spec.directive} `);
    }
  });

  test("skips a directive the box's nginx is too old to accept", () => {
    // `http2 on;` at server scope arrived in 1.25.1. On an older bare-host install it
    // fails `openresty -t`, the vhost rolls back, and the operator's setting vanishes
    // with no explanation — so the renderer drops it instead of trying.
    expect(renderProxyTlsOptions({ http2: true }, [1, 24, 0])).toBe("");
    expect(renderProxyTlsOptions({ http2: true }, [1, 25, 1])).toContain("http2 on;");
    // Unknown version (detection unavailable on some executors) → emit; `-t` +
    // rollback is the net, and silently dropping a setting is worse.
    expect(renderProxyTlsOptions({ http2: true })).toContain("http2 on;");
    expect(renderProxyTlsOptions({ http2: true }, null)).toContain("http2 on;");
  });
});

describe("the generated vhost carries the tunables in every server block", () => {
  test("both :80 and :443 get the shared directives at server scope", async () => {
    // The :80 block is not decorative: behind a TLS-terminating CDN (Cloudflare
    // "Flexible") it is the block that actually serves, so a limit that only exists
    // on :443 is a 413 for exactly those users.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...PROXY, proxy: FULL_PROXY });
    const c = conf("app-example-com")!;

    expect(serverBlocks(c)).toHaveLength(2);
    for (const spec of PROXY_DIRECTIVES.filter((d) => !d.tlsOnly)) {
      expect(httpBlock(c), spec.key).toContain(`${spec.directive} `);
      expect(tlsBlock(c), spec.key).toContain(`${spec.directive} `);
    }
  });

  test("directives sit above `location /`, so they cover every location", async () => {
    // Inside `location /` they would miss the webhook location and every
    // path-prefix proxy the project also owns.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({
      ...PROXY,
      proxy: FULL_PROXY,
      webhookProxy: "http://127.0.0.1:3009/hooks",
    });
    const c = conf("app-example-com")!;

    for (const block of serverBlocks(c)) {
      const serve = block.indexOf("location / {");
      for (const spec of PROXY_DIRECTIVES) {
        const at = block.indexOf(`\n    ${spec.directive} `);
        if (at === -1) continue;
        // Brace depth 0 = directly in `server { }`, so every location inherits it.
        expect(braceDepthAt(block, at), spec.key).toBe(0);
        expect(at, spec.key).toBeLessThan(serve);
      }
    }
  });

  test("http2 lands ONLY in the TLS block", async () => {
    // In a `listen 80` block it would enable cleartext h2c, which no browser
    // negotiates — and every generated vhost has a :80 block, including the one
    // that exists only to answer the ACME challenge.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...PROXY, proxy: { http2: true, clientMaxBodySize: "50m" } });
    const c = conf("app-example-com")!;

    expect(tlsBlock(c)).toContain("http2 on;");
    expect(httpBlock(c)).not.toContain("http2");
    expect(httpBlock(c)).toContain("client_max_body_size 50m;");
  });

  test("an HTTP-only vhost never gets http2", async () => {
    // No cert yet: one `listen 80` block and nothing else.
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, proxy: { http2: true } });
    const c = conf("app-example-com")!;
    expect(serverBlocks(c)).toHaveLength(1);
    expect(c).not.toContain("http2");
  });

  test("the bootstrap-TLS shape carries them too", async () => {
    // The placeholder-cert vhost is a real listener a real browser hits; dropping
    // the tunables there would make the limits appear only once ACME succeeds.
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...OURS, proxy: { clientMaxBodySize: "50m", http2: true } });
    const c = conf("app-example-com")!;
    expect(c).toContain(`${BOOTSTRAP_DIR}/fullchain.pem`);
    expect(httpBlock(c)).toContain("client_max_body_size 50m;");
    expect(tlsBlock(c)).toContain("client_max_body_size 50m;");
    expect(tlsBlock(c)).toContain("http2 on;");
    expect(httpBlock(c)).not.toContain("http2");
  });

  test("a static route gets them as well", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({
      domain: "app.example.com",
      tls: true,
      staticRoot: "/opt/openship/static/site",
      proxy: { clientMaxBodySize: "50m", gzip: true },
    });
    const c = conf("app-example-com")!;
    expect(c).toContain("client_max_body_size 50m;");
    expect(c).toContain("gzip on;");
  });
});

describe("render → parse round-trip (the renderer and the read-back agree)", () => {
  /** Read our own edge back the way the live read-back and migrate both do. */
  async function scanBack(conf: string) {
    const exec = async (cmd: string) => (cmd.startsWith("cat ") ? conf : "");
    const result = await scanOpenshipEdge({ exec } as unknown as CommandExecutor);
    return result.sites.find((s) => s.serverNames.includes("app.example.com"))!;
  }

  test("every value we wrote comes back out of the generated config", async () => {
    // This is the test that keeps drift detection honest: the UI compares a live
    // parse against `expectedProxyState`, so any field the parser can't read back
    // reports permanent drift on a box serving exactly what we asked for.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...PROXY, proxy: FULL_PROXY });

    const site = await scanBack(conf("app-example-com")!);
    expect(site.ssl).toBe(true);
    expect(site.proxy).toEqual(expectedProxyState(FULL_PROXY, { tls: true }));
  });

  test("an unset directive comes back absent, not defaulted", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...PROXY, proxy: { clientMaxBodySize: "50m" } });

    const site = await scanBack(conf("app-example-com")!);
    expect(site.proxy).toEqual({ clientMaxBodySize: "50m" });
    expect(site.proxyRaw).toEqual({ clientMaxBodySize: "50m" });
  });

  test("gzip's companion defaults read back as expected, not as drift", async () => {
    // `gzip: true` also writes `gzip_min_length 1024`. A read-back that compared the
    // live vhost against the raw settings saw a value nobody asked for and reported
    // drift forever — hence `expectedProxyState`.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...PROXY, proxy: { gzip: true } });

    const site = await scanBack(conf("app-example-com")!);
    expect(site.proxy).toEqual({ gzip: true, gzipMinLength: 1024 });
    expect(site.proxy).toEqual(expectedProxyState({ gzip: true }, { tls: true }));
  });

  test("a plaintext vhost reads back without the TLS-only directives", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, proxy: { http2: true, gzip: true } });

    const site = await scanBack(conf("app-example-com")!);
    expect(site.ssl).toBe(false);
    expect(site.proxy).toEqual(expectedProxyState({ http2: true, gzip: true }, { tls: false }));
    expect(site.proxy?.http2).toBeUndefined();
  });
});

describe("issuing a certificate keeps the tunables", () => {
  test("the route sidecar carries them, so the re-register is exact", async () => {
    // provisionCert re-registers from this file rather than re-deriving the route
    // from the conf. If `proxy` weren't in it, issuing a cert would quietly revert
    // the site to nginx's 1 MB / 60 s defaults.
    const { nginx, files } = setup();
    await nginx.registerRoute({ ...PROXY, proxy: { clientMaxBodySize: "50m", gzip: true } });

    const sidecar = JSON.parse(files.get(`${SITES}/app-example-com.route.json`)!) as RouteConfig;
    expect(sidecar.proxy).toEqual({ clientMaxBodySize: "50m", gzip: true });
  });

  test("a legacy route with no sidecar keeps them by scraping its own vhost", async () => {
    // Routes registered before the sidecar existed fall back to reading the conf.
    // Same table as the renderer, read backwards — so the recovery is not a
    // hand-maintained subset that silently drops the newer directives.
    const opts: FakeOpts = { certDomains: [] };
    const { nginx, files, conf } = setup(opts);
    await nginx.registerRoute({ ...PROXY, proxy: FULL_PROXY });
    expect(conf("app-example-com")).not.toContain("listen 443 ssl;");

    files.delete(`${SITES}/app-example-com.route.json`);
    // certbot "succeeds" and the cert appears on disk.
    opts.certDomains!.push("app.example.com");
    // ensureIssued still fails in the fake (no real cert to read), which is AFTER
    // the re-register we care about.
    await nginx.provisionCert("app.example.com", { force: true }).catch(() => undefined);

    const c = conf("app-example-com")!;
    // Proof the conf was rewritten: it grew the TLS listener.
    expect(c).toContain("listen 443 ssl;");
    for (const spec of PROXY_DIRECTIVES.filter((d) => !d.tlsOnly)) {
      expect(c, spec.key).toContain(`${spec.directive} `);
    }
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

  test("KEEPS the edge-target challenge location — a 301 host is still a valid target", async () => {
    // Same reasoning as ACME above, and the same mechanism: both are interpolated in
    // their own slot OUTSIDE sharedBody, so the canonical-redirect suppression can't
    // reach them, and both out-prefix `location /` so the 301 inside it never runs
    // for the challenge path. Openship Cloud's edge can therefore verify a target
    // whose vhost redirects — which `hostnameTargetWarning` warns breaks the free
    // URL, but does NOT break verification.
    const { nginx, conf } = setup({ certDomains: ["www.example.com"] });
    await nginx.registerRoute(REDIRECT);
    const c = wwwConf(conf);
    expect(c).toContain(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);
    expect(c).toContain(`root ${EDGE_CHALLENGE_ROOT};`);
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
// The default catch-all owns `443 ssl default_server` and answers there itself.
describe("default catch-all owns unmatched HTTPS hosts", () => {
  test("ensureOpenRestyConfig writes a 443 default_server serving the not-found page", async () => {
    const files = new Map<string, string>();
    const calls: string[] = [];
    // nginx.conf already present → exercises the steady-state path (not bootstrap).
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    // openssl succeeds here, so the placeholder cert exists and the handshake can
    // complete — the point of #431.
    await ensureOpenRestyConfig(makeExecutor(files, {}, calls), PATHS);
    const def = files.get(`${SITES}/_default.conf`);
    expect(def).toBeDefined();
    expect(def).toContain("listen 443 ssl default_server;");
    const { certPath, keyPath } = edgeDefaultCertPaths(PATHS.confDir);
    expect(def).toContain(`ssl_certificate ${certPath};`);
    expect(def).toContain(`ssl_certificate_key ${keyPath};`);
    expect(def).toContain(EDGE_NOT_FOUND_HTML);
    // and the HTTP catch-all stays a default_server too (no fallthrough on :80),
    // now answering with the same page instead of a bare `return 404`.
    expect(def).toContain("listen 80 default_server;");
    expect(calls.some((c) => c.includes("openssl req -x509"))).toBe(true);
  });

  test("falls back to refusing the handshake when the cert cannot be made", async () => {
    // The fail-safe that matters most: naming an ssl_certificate that is not on disk
    // does not cost us a page, it stops OpenResty loading the config at all — so
    // `openresty -t` fails, the deploy's reload is refused, and every later route
    // change on the box is refused with it. A box with no openssl keeps the
    // unfriendly TLS error; it does not lose routing.
    const files = new Map<string, string>();
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    await ensureOpenRestyConfig(makeExecutor(files, { noOpenssl: true }, []), PATHS);
    const def = files.get(`${SITES}/_default.conf`)!;
    expect(def).toContain("ssl_reject_handshake on;");
    expect(def).not.toContain("ssl_certificate ");
    // The :80 half still lands — it needs no certificate.
    expect(def).toContain(EDGE_NOT_FOUND_HTML);
  });

  test("the 443 catch-all is a dead end — it never proxies or serves a real cert", async () => {
    const files = new Map<string, string>();
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    await ensureOpenRestyConfig(makeExecutor(files, {}, []), PATHS);
    const def = files.get(`${SITES}/_default.conf`)!;
    const https = def.slice(def.indexOf("listen 443 ssl default_server;"));
    expect(https).not.toContain("proxy_pass");
    expect(https).not.toContain("/etc/letsencrypt");
  });

  test("catch-all is re-written on every ensure (self-heals a stale 80-only copy)", async () => {
    const files = new Map<string, string>();
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    // Simulate an already-deployed box whose _default.conf predates the 443 default.
    files.set(`${SITES}/_default.conf`, "server {\n    listen 80 default_server;\n}\n");
    await ensureOpenRestyConfig(makeExecutor(files, {}, []), PATHS);
    expect(files.get(`${SITES}/_default.conf`)).toContain("listen 443 ssl default_server;");
  });

  test("does NOT carry the edge-target challenge — that block is never evaluated", async () => {
    // The container edge is the only install path and it skips ensureOpenRestyConfig,
    // so emitting the challenge location here would be coverage we don't have. The
    // catch-all equivalent is in the baked image; the mechanism is the per-target
    // challenge vhost, which our own code writes into the bind-mounted sites-enabled.
    const files = new Map<string, string>();
    files.set(PATHS.confPath, `http {\n    include ${SITES}/*.conf;\n}\n`);
    await ensureOpenRestyConfig(makeExecutor(files, {}, []), PATHS);
    expect(files.get(`${SITES}/_default.conf`)!).not.toContain(EDGE_CHALLENGE_URL_PREFIX);
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
