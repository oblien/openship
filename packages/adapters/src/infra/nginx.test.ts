import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  NginxProvider,
  isAcmePortBindFailure,
  summarizeCertbotFailure,
  VHOST_GENERATION,
  readVhostGeneration,
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
import { makeTestCert } from "../system/proxy/test-certs";
import { compileVercelRouting } from "./vercel-routing";
import {
  OPENRESTY_DEFAULT_PATHS,
  luaSourceAvailable,
  RULES_GUARD_PATH,
  ACME_HTTP01_PORT,
  EDGE_CHALLENGE_DIR,
  EDGE_CHALLENGE_ROOT,
  EDGE_CHALLENGE_URL_PREFIX,
  ensureOpenRestyConfig,
  edgeDefaultCertPaths,
  type OpenRestyPaths,
} from "./openresty-lua";
import { EDGE_NOT_FOUND_HTML } from "./edge-not-found";
import type { CommandExecutor, RouteConfig } from "../types";
import type { RootChecked } from "../system/privilege";

// L1 — config GENERATION. Proves NginxProvider emits the right nginx directives
// for each branch, that the injection guard holds, and that a failed
// `openresty -t` rolls the vhost back. It does NOT prove real nginx accepts the
// output — that's the L3 docker suite. (See the routing-rules test audit.)

const SITES = "/tmp/openship-nginx-test/sites-enabled";
const PATHS = { ...OPENRESTY_DEFAULT_PATHS, sitesDir: SITES };

interface FakeOpts {
  /** Simulate the combined validate/reload command failing. */
  failReload?: boolean;
  /** Abort the owning cleanup exactly when the primary reload fails. */
  abortOnReloadFailure?: AbortController;
  /** Simulate nginx rejecting the configuration in both validation attempts. */
  failValidation?: boolean;
  /** Listener shape exposed while recovering a failed bare-host reload. */
  reloadListener?:
    | "verified-nginx"
    | "verified-nginx-worker"
    | "mixed-nginx"
    | "same-port-mixed-nginx"
    | "foreign-nginx"
    | "foreign-nginx-config"
    | "container-nginx"
    | "unclassified"
    | "unknown"
    | "none";
  /** Replace the verified master's args immediately after its generation capture. */
  replaceMasterAfterGenerationCapture?: boolean;
  /** Simulate hidepid/restricted procfs for the otherwise verified host master. */
  unreadableMasterCgroup?: boolean;
  /** Simulate losing the SSH/socket-table channel after config validation. */
  failListenerProbe?: boolean;
  /** Domains whose Let's Encrypt fullchain exists (drives the TLS branch). */
  certDomains?: string[];
  /** Simulate an edge with no `openssl` CLI (bootstrap cert can't be produced). */
  noOpenssl?: boolean;
  /** Simulate a `chmod` the edge refuses — a read-only mount, or (on a container
   *  edge, where commands run inside and file ops land on the host) a path the
   *  container's shell cannot see. */
  failChmod?: boolean;
  provider?: Partial<NginxProviderOptions>;
  certbotFailure?: string;
  paths?: OpenRestyPaths;
}

/** Stateful fake executor: in-memory file map + atomic-rename (`mv`) handling.
 *  Detection commands throw so reload() keeps the cached sitesDir. */
function makeExecutor(
  files: Map<string, string>,
  opts: FakeOpts,
  calls: string[],
  removed: string[] = [],
  writes: Array<{ path: string; content: string }> = [],
): RootChecked {
  let masterGenerationCaptured = false;
  const exec = async (command: string): Promise<string> => {
    calls.push(command);
    // openresty path detection (reload re-detects) → fail so cached paths stick.
    if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
    if (
      opts.failListenerProbe &&
      (command.startsWith("ss -tlnp") ||
        command.startsWith("sudo -n ") ||
        command.includes("cat /proc/net/tcp"))
    ) {
      throw new Error("SSH connection dropped");
    }
    const reloadListener = opts.reloadListener ?? "verified-nginx";
    if (command.startsWith("ss -tlnp sport = :") && reloadListener !== "none") {
      if (reloadListener === "unknown") {
        return "LISTEN 0 511 0.0.0.0:443 0.0.0.0:*";
      }
      if (reloadListener === "same-port-mixed-nginx") {
        return command.includes(":80")
          ? 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=321,fd=6))\n' +
              'LISTEN 0 511 127.0.0.1:80 0.0.0.0:* users:(("nginx",pid=333,fd=7))'
          : 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=321,fd=6))';
      }
      const pid =
        reloadListener === "mixed-nginx"
          ? command.includes(":80")
            ? 321
            : 333
          : reloadListener === "verified-nginx-worker"
            ? 322
            : reloadListener === "foreign-nginx"
              ? 333
              : reloadListener === "foreign-nginx-config"
                ? 334
                : reloadListener === "container-nginx"
                  ? 336
                  : reloadListener === "unclassified"
                    ? 335
                    : 321;
      return `LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=${pid},fd=6))`;
    }
    if (command === "ps -p 321 -o args= 2>/dev/null || true") {
      if (opts.replaceMasterAfterGenerationCapture && masterGenerationCaptured) {
        return `nginx: master process ${PATHS.bin} -c /etc/nginx/foreign.conf`;
      }
      return "nginx: master process /usr/sbin/nginx -g daemon on;";
    }
    if (command === "ps -p 322 -o args= 2>/dev/null || true") {
      return "nginx: worker process";
    }
    if (command === "ps -p 333 -o args= 2>/dev/null || true") {
      return "nginx: master process /usr/sbin/nginx -g daemon on;";
    }
    if (command === "ps -p 334 -o args= 2>/dev/null || true") {
      return `nginx: master process ${PATHS.bin} -c /etc/nginx/foreign.conf`;
    }
    if (command === "ps -p 336 -o args= 2>/dev/null || true") {
      return `nginx: master process ${PATHS.bin} -g daemon on;`;
    }
    if (command.includes("/proc/322/status")) return "321";
    if (command.includes("kill -HUP")) {
      if (opts.failReload && opts.reloadListener === undefined) {
        opts.abortOnReloadFailure?.abort();
        throw new Error("nginx reload signal failed");
      }
      return "";
    }
    if (command.includes("/proc/321/stat")) {
      masterGenerationCaptured = true;
      return "987";
    }
    if (command === "cat /proc/336/cgroup 2>/dev/null") {
      return `0::/docker/${"a".repeat(64)}`;
    }
    if (command.startsWith("readlink -f ")) {
      if (command.includes("/proc/333/exe")) return "/usr/sbin/nginx";
      if (command.includes("/proc/334/exe")) return PATHS.bin;
      if (command.includes("/proc/336/exe")) return PATHS.bin;
      if (command.includes("/proc/321/exe")) return PATHS.bin;
      if (command.includes("/etc/nginx/foreign.conf")) return "/etc/nginx/foreign.conf";
      if (command.includes(PATHS.bin)) return PATHS.bin;
      if (command.includes(PATHS.confPath)) return PATHS.confPath;
      return "";
    }
    if (command === "cat /proc/321/cgroup 2>/dev/null") {
      if (opts.unreadableMasterCgroup) throw new Error("permission denied");
      return "0::/system.slice/openship-openresty.service";
    }
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
    if (command.startsWith("chmod ") && opts.failChmod) {
      throw new Error("chmod: cannot access operand: No such file or directory");
    }
    if (command.startsWith("mv -f ")) {
      // Pair swap: `mv -f 'staging/fullchain.pem' 'staging/privkey.pem' 'dir'/`
      const paths = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const dir = paths.pop()!;
      for (const src of paths) {
        const c = files.get(src);
        if (c !== undefined) {
          files.set(`${dir}/${src.split("/").pop()}`, c);
          files.delete(src);
        }
      }
      return "";
    }
    // `grep -L <pattern> <dir>/*.conf` — files that do NOT contain the pattern, which is
    // how reapplyStoredRoutes asks "which vhosts are behind?" in one round trip.
    const grepL = command.match(/^grep -L '([^']*)' '([^']+)'\/\*\.conf/);
    if (grepL) {
      const pattern = new RegExp(grepL[1]!, "m");
      return [...files.keys()]
        .filter((k) => k.startsWith(`${grepL[2]}/`) && k.endsWith(".conf"))
        .filter((k) => !pattern.test(files.get(k)!))
        .join("\n");
    }
    // Directory listing for reapplyStoredRoutes: basenames of everything under the dir.
    const ls = command.match(/^ls -1 '([^']+)'/);
    if (ls) {
      const prefix = `${ls[1]}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .join("\n");
    }
    const mv = command.match(/^mv '([^']+)' '([^']+)'$/);
    if (mv) {
      const c = files.get(mv[1]);
      if (c !== undefined) {
        files.set(mv[2], c);
        files.delete(mv[1]);
      }
      return "";
    }
    if (command.includes(" -t ") && opts.failValidation) {
      throw new Error("nginx: [emerg] configuration test failed");
    }
    // The reload script contains `-t ... -s reload`; either failure exits non-zero.
    if (command.includes("-s reload")) {
      if (opts.failReload) throw new Error("nginx: [emerg] configuration test failed");
      return "";
    }
    return "";
  };
  return {
    exec,
    writeFile: async (p: string, c: string) => {
      writes.push({ path: p, content: c });
      files.set(p, c);
    },
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) =>
      files.has(p) ||
      (opts.certDomains ?? []).some((d) => p.startsWith(`/etc/letsencrypt/live/${d}/`)),
    mkdir: async () => {},
    rm: async (p: string) => {
      removed.push(p);
      files.delete(p);
    },
  } as unknown as RootChecked;
}

function setup(opts: FakeOpts = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const removed: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const nginx = new NginxProvider({
    ...opts.provider,
    paths: opts.paths ?? PATHS,
    executor: makeExecutor(files, opts, calls, removed, writes),
  });
  return {
    nginx,
    files,
    calls,
    removed,
    writes,
    conf: (slug: string) => files.get(`${SITES}/${slug}.conf`),
  };
}

const PROXY: RouteConfig = {
  domain: "app.example.com",
  tls: true,
  targetUrl: "http://127.0.0.1:3009",
};
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
  const hasChallenge = (c: string) => c.includes(`location ^~ ${EDGE_CHALLENGE_URL_PREFIX} {`);

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

/**
 * A free `<slug>.opsh.io` host is served by Openship Cloud's edge, which proxies here on
 * plain :80 — so the peer is the edge and the visitor is named in `X-Real-IP`. The
 * http-scope realip block reads CF-Connecting-IP (for Cloudflare-fronted custom
 * domains), a header this front does not send, so inheriting it left `remote_addr` as
 * the edge for every free-domain visitor: one rate-limit bucket for the planet, IP bans
 * that ban the edge, one country for everyone, and the edge's own address forwarded to
 * the app as `X-Real-IP`.
 */
describe("NginxProvider real-ip for a Cloud-fronted free host", () => {
  const FREE: RouteConfig = {
    domain: "myapp.opsh.io",
    tls: false,
    targetUrl: "http://127.0.0.1:3009",
  };

  test("overrides the header at server scope, ahead of anything that serves", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(FREE);
    const c = conf("myapp-opsh-io")!;
    expect(c).toContain("real_ip_header X-Real-IP;");
    // Server scope, not location scope: realip has to run for the rules guard, the
    // logger and `location /` alike.
    expect(c.indexOf("real_ip_header")).toBeLessThan(c.indexOf("location / {"));
    // Vhost-anchored rather than peer-anchored: the Cloud edge's egress address is not
    // knowable from this box, and a peer list that misses it ignores the header silently.
    // Bounded by the server_name — see cloudEdgeRealIpConf.
    expect(c).toContain("set_real_ip_from 0.0.0.0/0;");
  });

  test("a custom domain does NOT get the blanket trust", async () => {
    // The bound that makes the free-host block acceptable. On a custom domain the peer list
    // is the security property, and trusting any peer would let a visitor choose their own
    // rate-limit bucket and dodge IP bans.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(PROXY);
    expect(conf("app-example-com")).not.toContain("set_real_ip_from");
  });

  test("puts it in the same block as the rules guard, which is what reads the result", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(FREE);
    const c = conf("myapp-opsh-io")!;
    if (luaSourceAvailable()) {
      expect(c.indexOf("real_ip_header")).toBeLessThan(c.indexOf(RULES_GUARD_PATH));
    }
    // The corrected address is also what gets forwarded to the app.
    expect(c).toContain("proxy_set_header X-Real-IP $remote_addr;");
  });

  test("leaves a custom domain on the http-scope Cloudflare block", async () => {
    // The working path must not move: a custom domain behind Cloudflare keeps reading
    // CF-Connecting-IP from the edge's own nginx.conf, and a vhost-scope
    // set_real_ip_from would REPLACE that inherited list rather than add to it.
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(c).not.toContain("real_ip_header");
    expect(c).not.toContain("set_real_ip_from");
  });

  test("carries it on every shape the host can take, not just the HTTP-only one", async () => {
    // A free host normally has no cert here (Cloud terminates its TLS), but if one ever
    // lands the address recovery must not silently drop for :443 traffic.
    const { nginx, conf } = setup({ certDomains: ["myapp.opsh.io"] });
    await nginx.registerRoute({ ...FREE, tls: true });
    const c = conf("myapp-opsh-io")!;
    const [httpBlock, tlsBlock] = c.split("listen 443 ssl;");
    expect(httpBlock).toContain("real_ip_header X-Real-IP;");
    expect(tlsBlock).toContain("real_ip_header X-Real-IP;");
  });
});

/**
 * A generated-config fix reaches a running box ONLY through this sweep. `registerRoute` is
 * the sole writer and only a deploy, a domain save, a Retry or cert issuance calls it — so
 * a project nobody redeploys keeps the vhost its first deploy produced, which is how the
 * Cloud-fronted X-Real-IP block shipped and applied to nothing.
 */
describe("NginxProvider.reapplyStoredRoutes", () => {
  const FREE_ROUTE: RouteConfig = {
    domain: "myapp.opsh.io",
    tls: false,
    targetUrl: "http://127.0.0.1:3009",
  };
  /** What a pre-marker build left on disk: no generation line, no realip block. */
  const age = (conf: string) =>
    conf
      .replace(/^# openship-vhost-gen: \d+\n/m, "")
      .replace(/^\s*(real_ip_header|real_ip_recursive|set_real_ip_from) .*$/gm, "");

  test("stamps the generation it wrote, so staleness is readable off the file", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    expect(readVhostGeneration(conf("myapp-opsh-io")!)).toBe(VHOST_GENERATION);
  });

  test("re-emits a stale vhost from its own sidecar", async () => {
    const { nginx, files, conf } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    files.set(`${SITES}/myapp-opsh-io.conf`, age(conf("myapp-opsh-io")!));
    expect(conf("myapp-opsh-io")).not.toContain("real_ip_header X-Real-IP;");

    const result = await nginx.reapplyStoredRoutes();
    expect(result.repaired).toEqual(["myapp.opsh.io"]);
    expect(result.failed).toEqual([]);
    // The whole point: the fix landed without a deploy, and the route kept its target.
    expect(conf("myapp-opsh-io")).toContain("real_ip_header X-Real-IP;");
    expect(conf("myapp-opsh-io")).toContain("proxy_pass http://127.0.0.1:3009");
  });

  /**
   * The fleet is at generation 1, not at "unstamped": `age()` above removes the marker
   * line entirely, so every test here exercises only the `gen === null` branch. The
   * numbered one (`gen < VHOST_GENERATION`) is the branch every already-provisioned box
   * actually takes, and it had no coverage.
   */
  test("replays a vhost stamped with an OLDER generation, not just an unstamped one", async () => {
    const { nginx, files, conf } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    files.set(
      `${SITES}/myapp-opsh-io.conf`,
      conf("myapp-opsh-io")!
        .replace(/^# openship-vhost-gen: \d+$/m, "# openship-vhost-gen: 1")
        .replace(/^\s*proxy_pass_header X-Accel-Buffering;\n/m, ""),
    );
    expect(readVhostGeneration(conf("myapp-opsh-io")!)).toBe(1);
    expect(conf("myapp-opsh-io")).not.toContain("proxy_pass_header");

    const result = await nginx.reapplyStoredRoutes();

    expect(result.repaired).toEqual(["myapp.opsh.io"]);
    expect(result.failed).toEqual([]);
    expect(readVhostGeneration(conf("myapp-opsh-io")!)).toBe(VHOST_GENERATION);
    expect(conf("myapp-opsh-io")).toContain("proxy_pass_header X-Accel-Buffering;");
  });

  test("a converged box writes nothing and reloads nothing", async () => {
    // This runs on the ordinary edge-ensure path, so the steady state has to be free.
    const { nginx, calls, writes } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    const reloads = calls.filter((c) => c.includes("-s reload")).length;
    const written = writes.length;

    const result = await nginx.reapplyStoredRoutes();
    expect(result).toEqual({ scanned: 1, repaired: [], failed: [] });
    expect(calls.filter((c) => c.includes("-s reload")).length).toBe(reloads);
    expect(writes.length).toBe(written);
  });

  test("asks which vhosts are behind in ONE command", async () => {
    // It runs on the deploy path against a possibly-remote box, where every read is a round
    // trip. Reading 50 confs to learn that all 50 are current would put seconds on every
    // deploy — a cost nobody would attribute to a repair sweep that repairs nothing.
    const { nginx, calls } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    calls.length = 0;
    await nginx.reapplyStoredRoutes();
    expect(calls.filter((c) => c.startsWith("grep -L")).length).toBe(1);
  });

  test("does not resurrect a route whose conf was removed", async () => {
    // removeRoute deletes the conf and the sidecar together; a leftover sidecar must
    // never bring a vhost an operator removed back to life.
    const { nginx, files, conf } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    files.set(`${SITES}/myapp-opsh-io.conf`, age(conf("myapp-opsh-io")!));
    files.delete(`${SITES}/myapp-opsh-io.conf`);

    expect(await nginx.reapplyStoredRoutes()).toEqual({ scanned: 1, repaired: [], failed: [] });
    expect(conf("myapp-opsh-io")).toBeUndefined();
  });

  test("one unusable sidecar does not stop the rest of the sweep", async () => {
    const { nginx, files, conf } = setup();
    await nginx.registerRoute(FREE_ROUTE);
    files.set(`${SITES}/myapp-opsh-io.conf`, age(conf("myapp-opsh-io")!));
    files.set(`${SITES}/broken.conf`, "server {}");
    files.set(`${SITES}/broken.route.json`, "{not json");

    const result = await nginx.reapplyStoredRoutes();
    expect(result.repaired).toEqual(["myapp.opsh.io"]);
    expect(result.failed.map((f) => f.slug)).toEqual(["broken"]);
  });

  test("leaves a legacy route with no sidecar untouched", async () => {
    // Scraping its conf would recover only the primary target, dropping composite
    // locations and the webhook proxy — worse than leaving it as it is.
    const { nginx, files } = setup();
    files.set(`${SITES}/legacy.conf`, "server { listen 80; server_name legacy.test; }");
    expect(await nginx.reapplyStoredRoutes()).toEqual({ scanned: 0, repaired: [], failed: [] });
    expect(files.get(`${SITES}/legacy.conf`)).toBe(
      "server { listen 80; server_name legacy.test; }",
    );
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
    expect(files.get(CHALLENGE)).toContain(`location ^~ ${EDGE_CHALLENGE_URL_PREFIX} {`);
    // No token files yet — nothing has been issued.
    expect([...files.keys()].some((k) => k.startsWith(EDGE_CHALLENGE_DIR))).toBe(false);
  });

  test("a later token write reuses the existing vhost without a second reload", async () => {
    // The two call forms in sequence: ensure at deploy, then serve at verify time.
    const { nginx, files, calls } = setup();
    await nginx.serveEdgeChallenge({ host: "203.0.113.10" });
    const reloads = calls.filter((c) => c.includes("-s reload")).length;

    const r = await nginx.serveEdgeChallenge({
      host: "203.0.113.10",
      tokens: ["tok-abcdef123456"],
    });

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
    await nginx.serveEdgeChallenge({
      host: "203.0.113.10",
      tokens: ["tok-aaaaaaaaaaaa", "tok-bbbbbbbbbbbb"],
    });
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
    const r = await nginx.serveEdgeChallenge({
      host: "203.0.113.10",
      tokens: ["tok-abcdef123456"],
    });
    expect(r).toMatchObject({ served: true, via: "challenge-vhost" });
    const c = files.get(CHALLENGE)!;
    expect(c).toContain("server_name 203.0.113.10;");
    expect(c).toContain(`location ^~ ${EDGE_CHALLENGE_URL_PREFIX} {`);
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
    const reloadsAfterFirst = calls.filter(
      (c) => c.includes("reload") || c.includes("openresty"),
    ).length;
    files.delete(`${EDGE_CHALLENGE_DIR}/tok-abcdef123456`); // prove the token is re-asserted
    const r = await nginx.serveEdgeChallenge({
      host: "203.0.113.10",
      tokens: ["tok-abcdef123456"],
    });
    expect(r).toMatchObject({ served: true, via: "challenge-vhost" });
    expect(files.get(`${EDGE_CHALLENGE_DIR}/tok-abcdef123456`)).toBe("tok-abcdef123456");
    const reloadsAfterSecond = calls.filter(
      (c) => c.includes("reload") || c.includes("openresty"),
    ).length;
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
    const r = await nginx.serveEdgeChallenge({
      host: "app.example.com",
      tokens: ["tok-abcdef123456"],
    });
    expect(r).toMatchObject({ served: true, via: "existing-vhost" });
    expect(files.get(`${SITES}/_oblien-challenge-app-example-com.conf`)).toBeUndefined();
    expect(files.get(`${SITES}/app-example-com.conf`)).toBe(before); // untouched
  });

  test("refuses (with the file named) when a STALE vhost claims the host", async () => {
    const { nginx, files } = setup();
    // A vhost from before challenge support: claims the host, has no challenge location.
    files.set(
      `${SITES}/legacy-example-com.conf`,
      "server {\n    server_name legacy.example.com;\n}\n",
    );
    const r = await nginx.serveEdgeChallenge({
      host: "legacy.example.com",
      tokens: ["tok-abcdef123456"],
    });
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
    expect(c).toContain("location ^~ /.well-known/acme-challenge/");
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
    expect(JSON.parse(sidecar!)).toMatchObject({
      domain: "app.example.com",
      targetUrl: "http://127.0.0.1:3009",
    });
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
    const certbot = calls.find(
      (c) => c.startsWith("certbot 'certonly'") || c.startsWith("certbot certonly"),
    );
    expect(certbot).toBeDefined();
    expect(certbot).toContain("--standalone");
    expect(certbot).toContain("--http-01-port");
    expect(certbot).toContain(String(ACME_HTTP01_PORT));
    expect(certbot).toContain("--cert-name");
    expect(certbot).not.toContain("--webroot");
  });
  test("provisionCert issues via DNS-01 when challenge option is dns-01", async () => {
    const { nginx, calls } = setup();
    await nginx.registerRoute(PROXY);
    await expect(
      nginx.provisionCert("app.example.com", {
        challenge: "dns-01",
        dnsAuthHook: "/tmp/auth.sh",
        dnsCleanupHook: "/tmp/cleanup.sh",
      }),
    ).rejects.toThrow();
    const certbot = calls.find(
      (c) => c.startsWith("certbot 'certonly'") || c.startsWith("certbot certonly"),
    );
    expect(certbot).toBeDefined();
    expect(certbot).toContain("--manual");
    expect(certbot).toContain("--preferred-challenges");
    expect(certbot).toContain("dns");
    expect(certbot).toContain("--manual-auth-hook");
    expect(certbot).toContain("/tmp/auth.sh");
    expect(certbot).toContain("--manual-cleanup-hook");
    expect(certbot).toContain("/tmp/cleanup.sh");
    expect(certbot).not.toContain("--standalone");
    expect(certbot).not.toContain("--http-01-port");
  });

  test("generated DNS hooks are written on the executor target and removed", async () => {
    const { nginx, calls, writes, removed } = setup();
    await nginx.registerRoute(PROXY);
    await expect(
      nginx.provisionCert("app.example.com", {
        challenge: "dns-01",
        dnsAuthHookScript: "#!/bin/sh\necho auth\n",
        dnsCleanupHookScript: "#!/bin/sh\necho cleanup\n",
      }),
    ).rejects.toThrow();

    const authWrite = writes.find((write) => write.path.includes("/auth.sh.tmp-"));
    const cleanupWrite = writes.find((write) => write.path.includes("/cleanup.sh.tmp-"));
    expect(authWrite?.path).toMatch(/^\/etc\/letsencrypt\/\.openship-dns-/);
    expect(authWrite?.content).toContain("echo auth");
    expect(cleanupWrite?.content).toContain("echo cleanup");
    const certbot = calls.find((call) => call.includes("certonly"));
    const authPath = authWrite!.path.replace(/\.tmp-.+$/, "");
    expect(certbot).toContain(authPath);
    expect(certbot).toContain("OPENSHIP_DNS_RECORD_FILE=");
    expect(removed).toContain(authPath.replace(/\/auth\.sh$/, ""));
  });

  test("provisionCert automatically uses DNS-01 for wildcard domains", async () => {
    const { nginx, calls } = setup();
    await nginx.registerRoute({ ...PROXY, domain: "*.example.com" });
    await expect(nginx.provisionCert("*.example.com")).rejects.toThrow();
    const certbot = calls.find(
      (c) => c.startsWith("certbot 'certonly'") || c.startsWith("certbot certonly"),
    );
    expect(certbot).toBeDefined();
    expect(certbot).toContain("--manual");
    expect(certbot).toContain("--preferred-challenges");
    expect(certbot).toContain("dns");
    expect(certbot).toContain("-d");
    expect(certbot).toContain("*.example.com");
    expect(certbot).not.toContain("--standalone");
  });

  test("renewCert delegates to provisionCert with DNS-01 for wildcard domain with no lineage", async () => {
    const { nginx, calls } = setup();
    await expect(nginx.renewCert("*.example.com")).rejects.toThrow();
    const certbot = calls.find(
      (c) => c.startsWith("certbot 'certonly'") || c.startsWith("certbot certonly"),
    );
    expect(certbot).toBeDefined();
    expect(certbot).toContain("--manual");
    expect(certbot).toContain("--preferred-challenges");
    expect(certbot).toContain("dns");
  });

  test("renewCert reissues DNS-01 with freshly materialized hooks", async () => {
    const { nginx, calls, writes } = setup({ certDomains: ["app.example.com"] });
    await expect(
      nginx.renewCert("app.example.com", {
        challenge: "dns-01",
        dnsAuthHookScript: "#!/bin/sh\necho fresh\n",
        dnsCleanupHookScript: "#!/bin/sh\nexit 0\n",
      }),
    ).rejects.toThrow();
    expect(calls.some((call) => call.includes("certbot") && call.includes("'certonly'"))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes("certbot") && call.includes("'renew'"))).toBe(false);
    expect(writes.some((write) => write.path.includes("/auth.sh.tmp-"))).toBe(true);
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
    const dirChmodIdx = calls.findIndex(
      (c) => c.startsWith("chmod ") && c.includes("'700'") && c.includes(secretDir),
    );
    const fileChmodIdx = calls.findIndex(
      (c) => c.startsWith("chmod ") && c.includes("'600'") && c.includes(`${configPath}.tmp-`),
    );
    const publishIdx = calls.findIndex((c) => c.startsWith("mv ") && c.includes(`'${configPath}'`));
    expect(dirChmodIdx).toBeGreaterThanOrEqual(0);
    expect(fileChmodIdx).toBeGreaterThan(dirChmodIdx);
    expect(publishIdx).toBeGreaterThan(fileChmodIdx);
    expect(removed).toContain(secretDir);
  });

  // The other end of that cleanup. `provisionCert` can only remove a directory whose
  // path was RETURNED to it, so anything that throws while building the material has to
  // clean up itself — and the directory exists from the mkdir onward, not just from the
  // write. A refused `chmod` (read-only mount; or a container edge running the command
  // inside while the mkdir landed on the host) left one `.openship-eab-*` behind in
  // certbot's config dir on every attempt.
  test("a refused chmod leaves no EAB directory behind", async () => {
    const { nginx, calls, removed, writes } = setup({
      failChmod: true,
      provider: { acmeEabKid: "kid-123", acmeEabHmacKey: "c3VwZXItc2VjcmV0LWhtYWM" },
    });
    await expect(nginx.provisionCert("app.example.com")).rejects.toThrow(/chmod/);
    const dirChmod = calls.find((c) => c.startsWith("chmod ") && c.includes("'700'"));
    const secretDir = dirChmod?.match(/'(\/[^']*\.openship-eab-[^']*)'/)?.[1];
    expect(secretDir).toBeDefined();
    expect(removed).toContain(secretDir);
    // It failed BEFORE the secret bytes were staged, and certbot never ran.
    expect(writes.some((w) => w.path.includes(".openship-eab-"))).toBe(false);
    expect(calls.some((c) => c.startsWith("certbot "))).toBe(false);
  });

  test("rejects incomplete or malformed EAB configuration before issuance", () => {
    expect(() => setup({ provider: { acmeEabKid: "kid-only" } })).toThrow(/requires both/i);
    expect(() =>
      setup({
        provider: { acmeEabKid: "kid", acmeEabHmacKey: "not standard base64/+" },
      }),
    ).toThrow(/base64url/i);
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
    // `^~` for the same reason the ACME locations carry it: a compiled vercel.json
    // catch-all is a REGEX location, which out-ranks any plain prefix. Measured on
    // OpenResty 1.27.1.1 swallowing this one — either 308-ing the delivery away (losing
    // the POST body, so push→redeploy silently stops) or proxying the payload AND its
    // X-Hub-Signature to whatever origin the repo named.
    expect(conf("app-example-com")!).toContain("location ^~ /_openship/hooks/");
  });

  test("a compiled catch-all cannot out-rank the webhook or a composite backend", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      webhookProxy: "http://127.0.0.1:4000/api/webhooks/",
      proxyLocations: [
        { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
        {
          pathPrefix: "/",
          targetUrl: "http://127.0.0.1:9902",
          pattern: "/(.*)",
          upstreamPath: "/x/$1",
        },
      ],
    });
    const c = conf("app-example-com")!;
    expect(c).toContain("location ^~ /_openship/hooks/");
    expect(c).toContain("location ^~ /api/ {");
    // A loopback origin is one of OURS, so it keeps our Host rather than the origin's.
    expect(c).not.toContain("proxy_set_header Host 127.0.0.1:9902;");
  });

  test("rejects a domain with shell metacharacters (injection guard)", async () => {
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({ domain: "bad;rm -rf /", tls: false, targetUrl: "http://x" }),
    ).rejects.toThrow(/Invalid domain/);
  });

  test("bare reload validates before its verified direct HUP and never trusts the pidfile", async () => {
    const { nginx, calls } = setup();
    await nginx.registerRoute(PROXY);
    const validationIndex = calls.findIndex((command) =>
      command.includes(` -t -c '${PATHS.confPath}' 2>&1`),
    );
    const signalIndex = calls.findIndex((command) => command.includes("kill -HUP 321"));
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(signalIndex).toBeGreaterThan(validationIndex);
    expect(calls[signalIndex]).toContain("cat /proc/321/cgroup");
    expect(calls.some((command) => command.includes("-s reload"))).toBe(false);
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
    expect(c).toContain("location ^~ /.well-known/acme-challenge/");
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

  test("a stopped legacy edge converges route removal on disk without starting a daemon", async () => {
    const { nginx, files, calls } = setup({ reloadListener: "none" });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");
    files.set(`${SITES}/app-example-com.route.json`, JSON.stringify(PROXY));

    await nginx.removeRoute("app.example.com");

    expect(files.has(`${SITES}/app-example-com.conf`)).toBe(false);
    expect(files.has(`${SITES}/app-example-com.route.json`)).toBe(false);
    expect(calls.some((command) => command.trim() === PATHS.bin)).toBe(false);
    expect(calls.some((command) => /\b(?:pkill|kill -9)\b/.test(command))).toBe(false);
  });

  test("a stale PID file is never trusted, even when `nginx -s reload` would succeed", async () => {
    const { nginx, files, calls } = setup({
      // Linux commonly attributes the inherited listen socket to a worker;
      // safe reload must walk exactly one verified parent hop before signalling.
      reloadListener: "verified-nginx-worker",
    });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");

    await nginx.removeRoute("app.example.com");

    expect(files.has(`${SITES}/app-example-com.conf`)).toBe(false);
    expect(calls.filter((command) => command.includes("kill -HUP 321"))).toHaveLength(1);
    const generationCapture = calls.findIndex((command) => command.includes("/proc/321/stat"));
    const identityChecks = calls
      .map((command, index) => ({ command, index }))
      .filter(
        ({ command }) => command.startsWith("readlink -f ") && command.includes("/proc/321/exe"),
      );
    expect(generationCapture).toBeGreaterThanOrEqual(0);
    expect(identityChecks.some(({ index }) => index > generationCapture)).toBe(true);
    expect(calls.some((command) => command.includes("-s reload"))).toBe(false);
    expect(calls.some((command) => command.trim() === PATHS.bin)).toBe(false);
  });

  test("rejects PID reuse when the replacement master has different config args", async () => {
    const { nginx, files, calls } = setup({
      reloadListener: "verified-nginx-worker",
      replaceMasterAfterGenerationCapture: true,
    });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /executable and configuration could not be verified/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# existing route");
    expect(calls.some((command) => command.includes("kill -HUP 321"))).toBe(false);
  });

  test("an owner-hidden listener fails closed and restores the removed route", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      reloadListener: "unknown",
    });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /listener on port 80\/443 could not be identified/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# existing route");
    expect(calls.some((command) => /\b(?:pkill|kill -9)\b/.test(command))).toBe(false);
    expect(calls.some((command) => command.trim() === PATHS.bin)).toBe(false);
  });

  test("a timed-out removal never restores its vhost from a late reload failure", async () => {
    const controller = new AbortController();
    const { nginx, files } = setup({
      failReload: true,
      abortOnReloadFailure: controller,
    });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");
    files.set(`${SITES}/app-example-com.route.json`, JSON.stringify(PROXY));

    await expect(
      nginx.removeRoute("app.example.com", { signal: controller.signal }),
    ).rejects.toThrow(/reload signal failed/);

    expect(controller.signal.aborted).toBe(true);
    expect(files.has(`${SITES}/app-example-com.conf`)).toBe(false);
    expect(files.has(`${SITES}/app-example-com.route.json`)).toBe(false);
  });

  test("an inconclusive listener probe is never treated as proof the edge stopped", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      failListenerProbe: true,
    });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /listener probe was inconclusive/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# existing route");
    expect(calls.some((command) => /\b(?:pkill|kill -9)\b/.test(command))).toBe(false);
  });

  test("fails closed instead of treating a foreign live nginx as a stopped managed edge", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      reloadListener: "foreign-nginx",
    });
    files.set(`${SITES}/app-example-com.conf`, "# legacy Openship route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(/foreign listener owns/);

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# legacy Openship route");
    expect(calls.some((command) => command === "kill -HUP 333")).toBe(false);
    expect(calls.some((command) => command.startsWith("systemctl reload"))).toBe(false);
  });

  test("never HUPs a no--c master when detection selected a different fallback config", async () => {
    const { nginx, files, calls } = setup({
      paths: {
        ...PATHS,
        compiledConfPath: "/etc/openresty/compiled/nginx.conf",
      },
    });
    files.set(`${SITES}/app-example-com.conf`, "# legacy Openship route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /executable and configuration could not be verified/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# legacy Openship route");
    expect(calls.some((command) => command.includes("kill -HUP 321"))).toBe(false);
  });

  test("fails closed when managed OpenResty and a foreign daemon split ports 80/443", async () => {
    const { nginx, files, calls } = setup({ reloadListener: "mixed-nginx" });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /shares ports 80\/443 with a foreign listener/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# existing route");
    expect(calls.some((command) => command.includes("kill -HUP 321"))).toBe(false);
    expect(calls.some((command) => command.includes("kill -HUP 333"))).toBe(false);
  });

  test("fails closed when a foreign daemon shares the same port with managed OpenResty", async () => {
    const { nginx, files, calls } = setup({ reloadListener: "same-port-mixed-nginx" });
    files.set(`${SITES}/app-example-com.conf`, "# existing route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /shares ports 80\/443 with a foreign listener/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# existing route");
    expect(calls.some((command) => command.includes("kill -HUP 321"))).toBe(false);
    expect(calls.some((command) => command.includes("kill -HUP 333"))).toBe(false);
  });

  test("fails closed when the same binary is running a different config tree", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      reloadListener: "foreign-nginx-config",
    });
    files.set(`${SITES}/app-example-com.conf`, "# legacy Openship route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /executable and configuration could not be verified/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# legacy Openship route");
    expect(calls.some((command) => command.includes("kill -HUP 334"))).toBe(false);
    expect(calls.some((command) => command.startsWith("systemctl reload"))).toBe(false);
  });

  test("never signals a same-binary nginx master owned by a host-networked container", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      reloadListener: "container-nginx",
    });
    files.set(`${SITES}/app-example-com.conf`, "# legacy Openship route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(/container-backed/);

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# legacy Openship route");
    expect(calls.some((command) => command.includes("kill -HUP 336"))).toBe(false);
    expect(calls.some((command) => command.startsWith("systemctl reload"))).toBe(false);
  });

  test("never signals a same-binary master when procfs cannot prove its cgroup", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      unreadableMasterCgroup: true,
    });
    files.set(`${SITES}/app-example-com.conf`, "# legacy Openship route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /host ownership could not be proven/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# legacy Openship route");
    expect(calls.some((command) => command.includes("kill -HUP 321"))).toBe(false);
  });

  test("fails closed when a PID is visible but ps cannot describe its invocation", async () => {
    const { nginx, files, calls } = setup({
      failReload: true,
      reloadListener: "unclassified",
    });
    files.set(`${SITES}/app-example-com.conf`, "# legacy Openship route");

    await expect(nginx.removeRoute("app.example.com")).rejects.toThrow(
      /executable and configuration could not be verified/,
    );

    expect(files.get(`${SITES}/app-example-com.conf`)).toBe("# legacy Openship route");
    expect(calls.some((command) => command.includes("kill -HUP 335"))).toBe(false);
  });

  test("a failed `openresty -t` rolls the vhost back to the prior config", async () => {
    const { nginx, files, conf } = setup({ failValidation: true });
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

/**
 * Every `location` NAME in one server block, modifier stripped for the prefix forms.
 *
 * That is nginx's own duplicate test: it compares names, and `^~` only sets `noregex`
 * — so `location ^~ /` and `location /` are two inclusive locations called "/" and the
 * whole vhost is refused with `[emerg] duplicate location "/"`. Regex names are kept
 * marked, since nginx namespaces those separately.
 */
function locationNames(block: string): string[] {
  return [...block.matchAll(/^\s*location\s+(?:(=|\^~|~\*?)\s+)?(\S+)\s*\{/gm)].map((m) =>
    m[1]?.startsWith("~") ? `~ ${m[2]}` : m[2],
  );
}

/** The body of one location inside a server block, from its header to its closing brace. */
function locationBody(block: string, header: string): string {
  const start = block.indexOf(header);
  if (start < 0) throw new Error(`no ${header} in block`);
  return block.slice(start, block.indexOf("\n    }", start));
}

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

  // The sidecar is what `provisionCert` re-registers FROM, so anything missing from it
  // is silently reverted the moment a certificate is issued. `pattern` is the whole #510
  // fix (without it the rule falls back to a prefix and 308s every visitor to a literal
  // `/news/`), and `trailingSlash: false` is exactly the value a truthiness round-trip
  // loses — `!!false === false` is indistinguishable from "absent", which emits the
  // OPPOSITE redirect.
  test("the sidecar round-trips the compiled routing rules, pattern and tri-state included", async () => {
    const { nginx, files, conf } = setup();
    const compiled = compileVercelRouting({
      cleanUrls: true,
      trailingSlash: false,
      redirects: [{ source: "/blog/:path*", destination: "/news/:path*", permanent: true }],
      headers: [{ source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] }],
    });
    await nginx.registerRoute({
      domain: "app.example.com",
      tls: false,
      staticRoot: "/opt/openship/site",
      redirects: compiled.redirects,
      headerRules: compiled.headerRules,
      cleanUrls: compiled.cleanUrls,
      trailingSlash: compiled.trailingSlash,
    } as unknown as RouteConfig);

    const sidecar = JSON.parse(files.get(`${SITES}/app-example-com.route.json`)!) as RouteConfig;
    expect(sidecar.redirects?.[0].pattern).toBe("/blog/(.*)");
    expect(sidecar.headerRules).toEqual(compiled.headerRules);
    expect(sidecar.cleanUrls).toBe(true);
    // Present AND false — not merely falsy-or-missing.
    expect(sidecar.trailingSlash).toBe(false);
    expect("trailingSlash" in sidecar).toBe(true);

    // And re-registering FROM that sidecar reproduces the same vhost, which is what
    // provisionCert does. Byte-identical is the assertion that catches a lossy field.
    const before = conf("app-example-com")!;
    await nginx.registerRoute(sidecar);
    expect(conf("app-example-com")).toBe(before);
  });
});

/**
 * An installed private key must not be world-readable at rest.
 *
 * Certbot chmods the `live/` and `archive/` trees it owns to 0700, which is why nothing
 * here noticed: on a box where certbot ran, the directory hides the key whatever its own
 * mode is. `installCert` is the path where certbot never ran — an operator upload, a cert
 * carried in by a migration — so `_mkdir` creates `live/<domain>` at 0755 and the mode of
 * the key file is the only thing left protecting it.
 */
describe("installCert leaves the private key unreadable to other users", () => {
  /** Drop the two random staging segments so the assertion can be an exact path. */
  const chmods = (calls: string[]) =>
    calls
      .filter((c) => c.startsWith("chmod "))
      .map((c) => c.replace(/\.staging-[^/]+/, "").replace(/\.tmp-[^']+/, ""));

  test("chmods the key to 0600 on the staged path, before it is published", async () => {
    const { nginx, calls, files } = setup();
    await nginx.installCert("app.example.com", makeTestCert(["app.example.com"]));

    // On the STAGED path, because `mv` preserves the mode and a chmod afterwards would
    // leave a window where the key is already in place and still 0644.
    expect(chmods(calls)).toEqual([
      `chmod '600' '/etc/letsencrypt/live/app.example.com/privkey.pem'`,
    ]);
    const chmodAt = calls.findIndex((c) => c.startsWith("chmod "));
    const publishAt = calls.findIndex((c) => c.startsWith("mv -f "));
    expect(chmodAt).toBeGreaterThanOrEqual(0);
    expect(chmodAt).toBeLessThan(publishAt);

    // The pair still lands as a pair — the mode must not cost the atomic swap.
    expect(files.get("/etc/letsencrypt/live/app.example.com/privkey.pem")).toContain("PRIVATE KEY");
    expect(files.get("/etc/letsencrypt/live/app.example.com/fullchain.pem")).toContain(
      "CERTIFICATE",
    );
  });
});

/**
 * On a CONTAINER edge the two halves of "write it, then tighten it" travel different
 * channels: the write lands on the HOST (bind mount) while `chmod` runs INSIDE the
 * container. Only a mount whose two sides are the same string — `/etc/letsencrypt`,
 * `/opt/openship/static` in `EDGE_CONTAINER_MOUNTS` — makes those the same file, which
 * is why both of today's mode-passing callers happen to work.
 *
 * A mode aimed anywhere else either misses (a path the container's shell cannot see) or
 * hits a DIFFERENT file that exists there, leaving a TLS private key or the ACME EAB
 * HMAC key at the default mode with the operation reporting success. So the provider
 * refuses by name instead of writing the secret it cannot protect.
 */
describe("a container edge refuses a mode it cannot aim at the file it wrote", () => {
  /** A cert store OUTSIDE the same-path mounts — visible on the host, not in the container. */
  const OFF_MOUNT_CERT_DIR = "/var/lib/openship/edge/certs/live";

  test("installCert refuses rather than staging a key it cannot chmod", async () => {
    const { nginx, calls, files, writes } = setup({
      provider: { containerEdge: true, certDir: OFF_MOUNT_CERT_DIR },
    });

    const message = await nginx
      .installCert("app.example.com", makeTestCert(["app.example.com"]))
      .then(
        () => "",
        (err: Error) => err.message,
      );

    // Names the path it refused — the STAGED one, which is where the write was aimed —
    // and the mounts that would have been legal.
    expect(message).toMatch(/^Refusing to write .*privkey\.pem with mode 0600/);
    expect(message.replace(/\.staging-[^/]+/, "")).toContain(
      `${OFF_MOUNT_CERT_DIR}/app.example.com/privkey.pem`,
    );
    expect(message).toContain("/etc/letsencrypt");

    // Refused BEFORE the key bytes went anywhere: no write, no chmod at a path the
    // container may or may not own, and nothing published into the cert dir.
    expect(writes.some((w) => w.content.includes("PRIVATE KEY"))).toBe(false);
    expect(calls.some((c) => c.startsWith("chmod "))).toBe(false);
    expect(files.get(`${OFF_MOUNT_CERT_DIR}/app.example.com/privkey.pem`)).toBeUndefined();
    // The public half must not be published on its own either — a cert with no key
    // beside it fails `openresty -t` for the whole edge.
    expect(files.get(`${OFF_MOUNT_CERT_DIR}/app.example.com/fullchain.pem`)).toBeUndefined();
  });

  test("the EAB ini refuses too, and leaves no directory or secret behind", async () => {
    const hmac = "c3VwZXItc2VjcmV0LWhtYWM";
    const { nginx, calls, removed, writes } = setup({
      provider: {
        containerEdge: true,
        certDir: OFF_MOUNT_CERT_DIR,
        acmeEabKid: "kid-123",
        acmeEabHmacKey: hmac,
      },
    });

    await expect(nginx.provisionCert("app.example.com")).rejects.toThrow(
      /Refusing to write .*\.openship-eab-.* with mode 0700/,
    );
    // The 0700 parent is refused first, so the HMAC never reaches disk and certbot
    // never runs — and the mkdir'd directory is still cleaned up.
    expect(writes.some((w) => w.content.includes(hmac))).toBe(false);
    expect(calls.some((c) => c.startsWith("certbot ") || c.startsWith("env "))).toBe(false);
    expect(removed.some((p) => p.includes(".openship-eab-"))).toBe(true);
  });

  test("but the mount they actually live on is still tightened", async () => {
    // The other half of the guard: refusing must not become "never chmod on a
    // container edge", which would ship the world-readable key this all exists to stop.
    const { nginx, calls, files } = setup({ provider: { containerEdge: true } });
    await nginx.installCert("app.example.com", makeTestCert(["app.example.com"]));

    expect(
      calls
        .filter((c) => c.startsWith("chmod "))
        .map((c) => c.replace(/\.staging-[^/]+/, "").replace(/\.tmp-[^']+/, "")),
    ).toEqual([`chmod '600' '/etc/letsencrypt/live/app.example.com/privkey.pem'`]);
    expect(files.get("/etc/letsencrypt/live/app.example.com/privkey.pem")).toContain("PRIVATE KEY");
  });

  /**
   * The placeholder cert mixes the same two channels the other way round: `openssl`
   * writes the pair on the COMMAND channel (inside the container) while `_exists` and
   * `_mkdir` are FILE ops (on the host). Nothing here passes a mode, so the chmod guard
   * above never fired — and the function's contract is to return two paths, which the
   * caller then writes into a `:443` vhost. Off a same-path mount those paths exist only
   * inside the container, so `openresty -t` fails for EVERY domain on the edge.
   */
  test("a placeholder cert it cannot place is declined, not published", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { nginx, conf, calls } = setup({
        provider: { containerEdge: true, certDir: OFF_MOUNT_CERT_DIR },
      });

      await nginx.registerRoute(OURS); // must not throw: a placeholder can't fail a deploy

      const c = conf("app-example-com")!;
      expect(c).not.toContain("listen 443 ssl;");
      expect(c).not.toContain("openship-bootstrap");
      expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
      // Declined before the key was generated, so nothing was left in the container's
      // own filesystem either.
      expect(calls.some((c) => c.startsWith("openssl "))).toBe(false);

      const said = warn.mock.calls.map((a) => String(a[0])).join("\n");
      expect(said).toContain("not the same path");
      expect(said).toContain("serving HTTP only");
      // The real reason, not the openssl-missing guess the generic failure path prints.
      expect(said).not.toContain("is openssl installed");
    } finally {
      warn.mockRestore();
    }
  });

  test("and on the mount it does live on, the placeholder key is still tightened", async () => {
    const { nginx, calls, files } = setup({ provider: { containerEdge: true } });
    await nginx.registerRoute(OURS);

    expect(files.get(`${BOOTSTRAP_DIR}/privkey.pem`)).toBe("PEM");
    // On the staged path, before the pair-swap publishes it.
    const chmodAt = calls.findIndex(
      (c) => c.startsWith("chmod '600' ") && c.includes(".staging-") && c.includes("privkey.pem"),
    );
    const publishAt = calls.findIndex((c) => c.startsWith("mv -f "));
    expect(chmodAt).toBeGreaterThanOrEqual(0);
    expect(chmodAt).toBeLessThan(publishAt);
  });
});

/**
 * `registerRoute` REPLACES the vhost, so re-registering with FEWER rules has to leave no
 * residue. The http-scope `map` prelude is the part that can rot: a variable still
 * referenced by an `add_header` whose `map` is gone is an `[emerg] unknown variable` that
 * fails `openresty -t` box-wide, and a duplicated prelude is a silently-wrong header.
 */
describe("re-registering a route leaves no stale rules", () => {
  const STATIC_ROUTE: RouteConfig = {
    domain: "app.example.com",
    tls: false,
    staticRoot: "/opt/openship/site",
  } as unknown as RouteConfig;

  const rules = (n: number) =>
    compileVercelRouting({
      headers: Array.from({ length: n }, (_, i) => ({
        source: `/p${i}/(.*)`,
        headers: [{ key: `X-P${i}`, value: String(i) }],
      })),
    }).headerRules;

  test("drops the map blocks and add_headers of rules that went away", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...STATIC_ROUTE, headerRules: rules(3) });
    const three = conf("app-example-com")!;
    expect(three.match(/map \$request_uri/g) ?? []).toHaveLength(3);

    await nginx.registerRoute({ ...STATIC_ROUTE, headerRules: rules(1) });
    const one = conf("app-example-com")!;
    expect(one.match(/map \$request_uri/g) ?? []).toHaveLength(1);
    expect(one).not.toContain("X-P1");
    expect(one).not.toContain("X-P2");
    // Every variable an add_header reads must still have a map that defines it.
    for (const [, name] of one.matchAll(/add_header \S+ \$(osh_hdr_\w+)/g)) {
      expect(one).toContain(`map $request_uri $${name} {`);
    }
  });

  test("and removing them all leaves no prelude at all", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...STATIC_ROUTE, headerRules: rules(2) });
    await nginx.registerRoute({ ...STATIC_ROUTE });
    const c = conf("app-example-com")!;
    expect(c).not.toContain("map $request_uri");
    expect(c).not.toContain("osh_hdr_");
    expect(c.startsWith("# Auto-generated by Openship")).toBe(true);
  });

  test("is idempotent — the same rules twice produce the same file", async () => {
    const { nginx, conf } = setup();
    const route = { ...STATIC_ROUTE, headerRules: rules(2), cleanUrls: true } as RouteConfig;
    await nginx.registerRoute(route);
    const first = conf("app-example-com")!;
    await nginx.registerRoute(route);
    expect(conf("app-example-com")).toBe(first);
  });

  test("a failed reload restores the PREVIOUS rules, not an empty vhost", async () => {
    // The rollback path with rules in play: the operator's live config must survive a
    // vhost that nginx rejects, rather than the domain losing its rules to a bad edit.
    const opts: FakeOpts = {};
    const { nginx, conf } = setup(opts);
    await nginx.registerRoute({ ...STATIC_ROUTE, headerRules: rules(2) });
    const good = conf("app-example-com")!;

    opts.failReload = true;
    await expect(nginx.registerRoute({ ...STATIC_ROUTE, headerRules: rules(5) })).rejects.toThrow();
    expect(conf("app-example-com")).toBe(good);
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

  // The upgrade has to cover every location that serves project traffic, not just
  // `location /`. A composite `/api/` (or any vercel.json rewrite) that skipped it stayed
  // answerable in cleartext AFTER the certificate landed — session cookies and
  // Authorization headers on the exact paths that carry them, with no way for a visitor
  // who typed `http://` to be moved off it.
  const API_LOC: RouteConfig = {
    ...OURS,
    proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" }],
  };

  test("a proxy location upgrades to https on :80, exactly like `location /`", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(API_LOC);
    const c = conf("app-example-com")!;
    const api = locationBody(httpBlock(c), "location ^~ /api/ {");
    expect(api).toContain("if ($openship_redirect_https) {");
    expect(api).toContain("return 301 https://$server_name$request_uri;");
    // Ahead of what serves — the chain is first-match-wins inside one location.
    expect(api.indexOf("$openship_redirect_https")).toBeLessThan(api.indexOf("proxy_pass"));
  });

  test("…and never on :443, where the guard variable is 1 and would loop", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(API_LOC);
    const c = conf("app-example-com")!;
    expect(locationBody(tlsBlock(c), "location ^~ /api/ {")).not.toContain(
      "$openship_redirect_https",
    );
  });

  test("…nor on a block with no real cert, which would bounce into nothing", async () => {
    const { nginx, conf } = setup(); // no issued cert → bootstrap listener only
    await nginx.registerRoute(API_LOC);
    const c = conf("app-example-com")!;
    for (const block of serverBlocks(c)) {
      expect(locationBody(block, "location ^~ /api/ {")).not.toContain("return 301 https://");
    }
  });

  // A 30x drops a webhook delivery's POST body, so this one location stays plaintext-
  // answerable on purpose — the invariant is deliberate, not an oversight to "fix".
  test("the webhook location is exempt from the upgrade", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({ ...OURS, webhookProxy: "http://127.0.0.1:4000/api/webhooks/" });
    const hooks = locationBody(
      httpBlock(conf("app-example-com")!),
      "location ^~ /_openship/hooks/ {",
    );
    expect(hooks).not.toContain("$openship_redirect_https");
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

// vercel.json `redirects` → an `if ($request_uri …) { return … }` chain at the head of
// every location that serves project traffic.
//
// These were once a location apiece, which nginx cannot express faithfully: a capture
// needs a REGEX location, but a regex location matches `$uri` (which nginx rewrites
// internally, so a rule re-fired on the SPA fallback and looped), out-ranks every plain
// prefix regardless of file order (inverting vercel.json's first-match-wins, and
// swallowing our own webhook/composite locations), and `return` drops the query string.
// A compiled `/(.*)` whose destination referenced no capture was worse still — it kept
// `path: "/"` and emitted a SECOND `location /`, i.e. `[emerg] duplicate location`, so
// the domain got no vhost at all.
describe("vercel.json path redirects", () => {
  const appConf = (conf: (slug: string) => string | undefined) => conf("app-example-com")!;
  /** The portable pattern as it is actually emitted: every capture excludes control
   *  characters, so a request cannot plant a bare CR in the Location header. */
  const emitted = (pattern: string) =>
    pattern
      .replace(/\(\.\*\)/g, "([^\\x00-\\x1f\\x7f]*)")
      .replace(/\(\.\+\)/g, "([^\\x00-\\x1f\\x7f]+)")
      .replace(/\(\[\^\/\]\+\)/g, "([^/\\x00-\\x1f\\x7f]+)")
      .replace(/\(\[\^\/\]\*\)/g, "([^/\\x00-\\x1f\\x7f]*)");
  /** Same, for a `$request_uri` sink: captures also exclude `?` so a greedy group cannot
   *  swallow the query string that `$is_args$args` is about to re-append. */
  const emittedQ = (pattern: string) => emitted(pattern).replace(/\\x7f\]/g, "\\x7f?]");
  /** The full `if` condition for a compiled pattern. */
  const ifPattern = (pattern: string) => `if ($request_uri ~ "^${emittedQ(pattern)}(?:[?].*)?$") {`;

  test("emits a capture-preserving redirect rule for a wildcard redirect", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      redirects: [
        {
          path: "/blog/",
          exact: false,
          statusCode: 308,
          destination: "/news/$1",
          pattern: "/blog/(.*)",
        },
      ],
    });
    const c = appConf(conf);
    expect(c).toContain(ifPattern("/blog/(.*)"));
    // Vercel preserves the query on a redirect; the old `return <dest>;` form dropped it.
    expect(c).toContain("return 308 /news/$1$is_args$args;");
    // Neither the unanchored prefix location (which produced the literal `/news/`
    // Location header, #510) nor a regex location (which re-fires on internal rewrites).
    expect(c).not.toContain("location /blog/ {");
    expect(c).not.toContain("location ~ ");
  });

  test("keeps a capture-free redirect on the same chain, anchored by exactness", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      redirects: [
        { path: "/old", exact: true, statusCode: 301, destination: "/new" },
        { path: "/legacy/", exact: false, statusCode: 302, destination: "/current" },
      ],
    });
    const c = appConf(conf);
    // Exact must not match a longer path, so it anchors past an optional query.
    expect(c).toContain('if ($request_uri ~ "^/old(?:[?].*)?$") {');
    expect(c).toContain("return 301 /new$is_args$args;");
    // A prefix rule needs no end anchor — anything may follow.
    expect(c).toContain('if ($request_uri ~ "^/legacy/") {');
    expect(c).toContain("return 302 /current$is_args$args;");
    expect(c).not.toContain("location = /old {");
    expect(c).not.toContain("location /legacy/ {");
  });

  // The bug this shape exists to prevent: a root-level source with a capture-free
  // destination is one of Vercel's own documented examples, and as a location it
  // duplicated `location /` — `[emerg] duplicate location "/"`, no vhost, and
  // registerRoute's rollback then DELETES the file for a brand-new domain.
  test("never emits a second `location /` for a root-level catch-all", async () => {
    const compiled = compileVercelRouting({
      redirects: [{ source: "/(.*)", destination: "https://vercel.com/docs" }],
    });
    expect(compiled.skipped).toEqual([]);
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, redirects: compiled.redirects });
    const c = appConf(conf);
    expect(c.match(/location \/ \{/g)).toHaveLength(1);
    expect(c).toContain("return 308 https://vercel.com/docs$is_args$args;");
  });

  test("redirect rules lead every serving location, in both server blocks", async () => {
    // First-match-wins inside one location, so the chain must precede what serves — and
    // it must be in the :80 block too, AFTER the https upgrade (reaching https first
    // costs nothing; being redirected on plain http then again on https costs a hop).
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute({
      ...OURS,
      redirects: [
        {
          path: "/blog/",
          exact: false,
          statusCode: 308,
          destination: "/news/$1",
          pattern: "/blog/(.*)",
        },
      ],
    });
    const c = appConf(conf);
    const rule = ifPattern("/blog/(.*)");
    for (const block of [httpBlock(c), tlsBlock(c)]) {
      const serve = block.slice(block.indexOf("location / {"));
      // Inside `location /` (so a `^~` challenge match never reaches it) and ahead of
      // what serves, since the chain is first-match-wins.
      expect(serve).toContain(rule);
      expect(serve.indexOf(rule)).toBeLessThan(serve.indexOf("proxy_pass"));
    }
    expect(httpBlock(c).indexOf("$openship_redirect_https")).toBeLessThan(
      httpBlock(c).indexOf(rule),
    );
  });

  // vercel.json is first-match-wins. As locations, a later capture-bearing rule became a
  // regex and out-ranked an earlier, narrower prefix one — so `/docs/legacy/x` answered
  // the `/docs/` rule. An ordered `if` chain in one location restores source order.
  test("evaluates redirects in vercel.json order, not by specificity", async () => {
    const compiled = compileVercelRouting({
      redirects: [
        { source: "/docs/legacy/:p*", destination: "/archive", permanent: true },
        { source: "/docs/:p*", destination: "/documentation/:p*", permanent: true },
      ],
    });
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, redirects: compiled.redirects });
    const c = appConf(conf);
    expect(c.indexOf("return 308 /archive")).toBeLessThan(
      c.indexOf("return 308 /documentation/$1"),
    );
  });

  // The emitter's pattern guard is a WHITELIST, so it has to admit every shape the
  // compiler can hand it — a guard narrower than the compiler would reject a valid
  // vercel.json at deploy time instead of at compile time.
  test("accepts every capture pattern compileVercelRouting can produce", async () => {
    const compiled = compileVercelRouting({
      redirects: [
        { source: "/blog/:path*", destination: "/news/:path*" }, // (.*)
        { source: "/all/:rest+", destination: "/every/:rest+" }, // (.+)
        { source: "/u/:id", destination: "/users/:id" }, // ([^/]+)
        { source: "/opt/:id?", destination: "/maybe/:id?" }, // ([^/]*)
        { source: "/v1.0/:rest*", destination: "/v2/:rest*" }, // escaped dot
        { source: "/:org/old/:rest*", destination: "/:org/new/:rest*" }, // multi-capture
      ],
    });
    expect(compiled.skipped).toEqual([]);
    expect(compiled.redirects.every((r) => r.pattern)).toBe(true);

    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, redirects: compiled.redirects });
    const c = appConf(conf);
    for (const r of compiled.redirects) {
      expect(c).toContain(ifPattern(r.pattern!));
      expect(c).toContain(`return ${r.statusCode} ${r.destination}$is_args$args;`);
    }
  });

  // `return` copies the capture into the Location header, so an unrestricted `.` would
  // let `/blog/a%0Db` plant a bare CR there. Verified against nginx 1.27.5: the hardened
  // class makes it fall through instead.
  test("excludes control characters and the query delimiter from every capture", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      redirects: [
        {
          path: "/blog/",
          exact: false,
          statusCode: 308,
          destination: "/news/$1",
          pattern: "/blog/(.*)",
        },
        {
          path: "/u/",
          exact: false,
          statusCode: 301,
          destination: "/users/$1",
          pattern: "/u/([^/]+)",
        },
      ],
    });
    const c = appConf(conf);
    // Spelled out rather than via the helpers so the guard's actual text is asserted.
    // `?` is excluded on top of the control characters because the sink is $request_uri:
    // a greedy `(.*)` would otherwise capture `x?a=1` whole and $is_args$args would then
    // append the query a SECOND time.
    expect(c).toContain('if ($request_uri ~ "^/blog/([^\\x00-\\x1f\\x7f?]*)(?:[?].*)?$") {');
    expect(c).toContain('if ($request_uri ~ "^/u/([^/\\x00-\\x1f\\x7f?]+)(?:[?].*)?$") {');
    // An unrestricted `.` would match a CR; nothing we emit may contain one.
    expect(c).not.toMatch(/\$request_uri ~ \S*\(\.[*+]\)/);
  });

  // A capture cannot go into `proxy_pass` — a variable there needs a `resolver` the edge
  // has none of, so it would fail at request time rather than at `nginx -t`.
  test("emits a wildcard rewrite as `rewrite … break` + a variable-free proxy_pass", async () => {
    const compiled = compileVercelRouting({
      rewrites: [{ source: "/proxy/:path*", destination: "https://api.example.com/v2/:path*" }],
    });
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, proxyLocations: compiled.proxyLocations });
    const c = appConf(conf);
    const match = `^${emitted("/proxy/(.*)")}$`;
    expect(c).toContain(`location ~ ${match} {`);
    expect(c).toContain(`rewrite ${match} /v2/$1 break;`);
    expect(c).toContain("proxy_pass https://api.example.com;");
    // An external origin needs its own Host and SNI, not ours.
    expect(c).toContain("proxy_set_header Host api.example.com;");
    expect(c).toContain("proxy_ssl_server_name on;");
  });

  test("keeps our Host on an internal prefix proxy location, and makes it `^~`", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" }],
    });
    const c = appConf(conf);
    // `^~` so a repo's compiled `/(.*)` regex cannot out-rank our own upstream and take
    // the project's authenticated /api traffic — cookies and all — to a third party.
    expect(c).toContain("location ^~ /api/ {");
    expect(c).toContain("proxy_pass http://10.0.0.5:3000;");
    expect(c).toContain("proxy_set_header Host $host;"); // ours, not the upstream's
    expect(c).not.toContain("proxy_ssl_server_name");
    expect(c).not.toContain("rewrite ");
  });

  // The rewrite twin of the `location /` duplication fixed for redirects above: a
  // capture-free destination keeps `pathPrefix: "/"` (Vercel's own documented shape), and
  // nginx compares location NAMES — `^~` only sets `noregex` — so `^~ /` next to `/` is
  // `[emerg] duplicate location "/"`. Routing failures never fail a deploy, so the vhost
  // is refused, rolled back, and the domain goes dark with a green deploy.
  test("never emits a proxy location that duplicates `location /`", async () => {
    const compiled = compileVercelRouting({
      rewrites: [{ source: "/:path*", destination: "https://api.example.com/v2" }],
    });
    expect(compiled.proxyLocations[0]?.pathPrefix).toBe("/"); // genuinely the root
    expect(compiled.proxyLocations[0]?.pattern).toBeUndefined(); // …as a plain prefix
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, proxyLocations: compiled.proxyLocations });
    const c = appConf(conf);
    expect(c).not.toContain("location ^~ / {");
    const names = locationNames(httpBlock(c));
    expect(names).toEqual([...new Set(names)]);
    // `location /` keeps serving the project's own upstream.
    expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
    expect(c).not.toContain("proxy_pass https://api.example.com/v2;");
  });

  // routing-apply and the compose deploy CONCATENATE a project's composite locations with
  // the compiled vercel.json ones, so one prefix can arrive twice — the same `[emerg]`.
  test("emits a repeated path prefix once, keeping the first upstream", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      proxyLocations: [
        { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
        { pathPrefix: "/api/", targetUrl: "http://10.0.0.9:3000" },
      ],
    });
    const c = appConf(conf);
    expect(c.match(/location \^~ \/api\/ \{/g)).toHaveLength(1);
    expect(c).toContain("proxy_pass http://10.0.0.5:3000;");
    expect(c).not.toContain("proxy_pass http://10.0.0.9:3000;");
  });

  // `/_openship/` is ours: a rewrite naming the webhook prefix duplicated the delivery
  // location (same `[emerg]`), and the repo's origin must never be the one that wins it.
  test("a rewrite cannot duplicate our own webhook location", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      webhookProxy: "http://127.0.0.1:4000/api/webhooks/",
      proxyLocations: [{ pathPrefix: "/_openship/hooks/", targetUrl: "http://attacker.example" }],
    });
    const c = appConf(conf);
    expect(c.match(/location \^~ \/_openship\/hooks\/ \{/g)).toHaveLength(1);
    expect(c).toContain("proxy_pass http://127.0.0.1:4000/api/webhooks/;");
    expect(c).not.toContain("attacker.example");
  });

  // A regex location outranks a plain prefix one, so a catch-all `vercel.json` rule used
  // to swallow the ACME challenge and no certificate for the host could ever issue.
  // Reproduced on 1.27.5: the challenge 308'd to `/landing/.well-known/acme-challenge/…`.
  test("a catch-all cannot out-rank the challenge locations", async () => {
    const compiled = compileVercelRouting({
      redirects: [{ source: "/:path*", destination: "/landing/:path*", permanent: true }],
    });
    expect(compiled.redirects[0].pattern).toBe("/(.*)"); // genuinely a catch-all
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, redirects: compiled.redirects });
    const c = appConf(conf);
    // `^~` stops nginx at the prefix and skips regex matching entirely. The redirect
    // chain now lives inside `location /`, which a `^~` prefix match never reaches — so
    // the challenge is safe on both counts.
    expect(c).toContain("location ^~ /.well-known/acme-challenge/ {");
    expect(c).toContain(`location ^~ ${EDGE_CHALLENGE_URL_PREFIX} {`);
    const challenge = c.indexOf("location ^~ /.well-known/acme-challenge/ {");
    expect(challenge).toBeLessThan(c.indexOf(ifPattern("/(.*)")));
  });

  // `^~` only protects while it is the LONGEST matching prefix, so a rule UNDER the
  // challenge path defeats it — answering HTTP-01 from an origin the repo names, which is
  // an attacker-mintable certificate for the operator's domain. `isSafePath` admits `.`
  // and `-`, so nothing in the compiler's charclass stopped this.
  test("refuses any rule under /.well-known/, in the compiler and at emit time", async () => {
    const compiled = compileVercelRouting({
      rewrites: [
        { source: "/.well-known/acme-challenge/a", destination: "http://attacker.example" },
      ],
      redirects: [{ source: "/.well-known/x", destination: "/y", permanent: true }],
    });
    expect(compiled.proxyLocations).toEqual([]);
    expect(compiled.redirects).toEqual([]);
    expect(compiled.skipped).toHaveLength(2);

    // A route can also arrive from the API or a sidecar, bypassing the compiler.
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({
        ...PROXY,
        proxyLocations: [
          { pathPrefix: "/.well-known/acme-challenge/a", targetUrl: "http://attacker.example" },
        ],
      }),
    ).rejects.toThrow(/well-known/);
  });

  // `$` is not in assertNoNginxInjection's charclass, and every value here lands in a
  // complex value: `proxy_pass http://$http_x_target` is an open proxy any visitor steers
  // with one request header, `return 307 https://$arg_next` an open redirect.
  test("refuses a destination or upstream that smuggles an nginx variable", async () => {
    const compiled = compileVercelRouting({
      rewrites: [{ source: "/p/:path*", destination: "http://$http_x_target/:path*" }],
      redirects: [
        { source: "/go/:p*", destination: "https://$arg_next" },
        { source: "/go2/:sub", destination: "https://:sub.example.com" },
      ],
    });
    expect(compiled.proxyLocations).toEqual([]);
    expect(compiled.redirects).toEqual([]);
    expect(compiled.skipped).toHaveLength(3);

    const { nginx } = setup();
    await expect(
      nginx.registerRoute({
        ...PROXY,
        proxyLocations: [{ pathPrefix: "/p/", targetUrl: "http://$http_x_target" }],
      }),
    ).rejects.toThrow(/variable/);
    await expect(
      nginx.registerRoute({
        ...PROXY,
        redirects: [
          { path: "/go/", exact: false, statusCode: 307, destination: "https://$arg_next" },
        ],
      }),
    ).rejects.toThrow(/variable/);
  });

  test("REFUSES a redirect whose pattern or destination could inject config", async () => {
    // The compiler sanitizes these, but a route also arrives from the API and from a
    // persisted sidecar — so the emitter re-checks rather than trusting its caller.
    const { nginx } = setup();
    const bad = [
      {
        path: "/a/",
        exact: false,
        statusCode: 301,
        destination: "/b/$1",
        pattern: "/a/(.*)$ { } location /x { deny all; } location ~ ^/y",
      },
      { path: "/a/", exact: false, statusCode: 301, destination: "/b;\n return 200 'pwned'" },
      { path: "/a;\n deny all; #", exact: true, statusCode: 301, destination: "/b" },
    ];
    for (const redirect of bad) {
      await expect(nginx.registerRoute({ ...PROXY, redirects: [redirect] })).rejects.toThrow();
    }
  });
});

// `headers` for a specific path, and the `cleanUrls`/`trailingSlash` URL shape. Both
// used to be dropped on the floor for self-hosted while cloud honoured them.
describe("vercel.json path headers and URL shape", () => {
  const appConf = (conf: (slug: string) => string | undefined) => conf("app-example-com")!;
  const STATIC: RouteConfig = {
    ...PROXY,
    targetUrl: undefined,
    staticRoot: "/opt/openship/site",
  } as unknown as RouteConfig;

  test("backs a path-scoped header with a $request_uri map, not a location", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      headerRules: [
        { path: "/", headers: [{ key: "X-Global", value: "g" }] },
        { path: "/api/", headers: [{ key: "Cache-Control", value: "no-store" }] },
      ],
    });
    const c = appConf(conf);
    // Global stays literal; path-scoped goes through a namespaced map variable.
    expect(c).toContain('add_header X-Global "g" always;');
    expect(c).toMatch(/map \$request_uri \$osh_hdr_app_example_com_0 \{/);
    expect(c).toContain('~^/api/ "no-store";');
    expect(c).toContain("add_header Cache-Control $osh_hdr_app_example_com_0 always;");
    // The map is http scope, so it must precede the server block.
    expect(c.indexOf("map $request_uri")).toBeLessThan(c.indexOf("server {"));
    // `$uri` follows internal rewrites, so it would miss the SPA-fallback case entirely.
    expect(c).not.toContain("map $uri ");
    // add_header inside a location would discard every inherited one.
    expect(c).not.toMatch(/location [^\n]*\{[^}]*add_header/);
  });

  test("keys the URL shape on $request_uri inside `location /`", async () => {
    // As regex locations on `$uri` these fired on nginx's OWN rewrites: `index` turned
    // `/docs/` into `/docs/index.html` → 308 `/docs/index`, and the SPA fallback turned
    // every 404 into a 308 to `/index`. Both reproduced on 1.27.5 before this changed.
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...STATIC, cleanUrls: true });
    const c = appConf(conf);
    expect(c).toContain('if ($request_uri ~ "^([^?]*)[.]html([?].*)?$") {');
    expect(c).toContain("return 308 $1$2;");
    expect(c).toContain("try_files $uri $uri.html $uri/ /index.html;");
    // Inside `location /`, so an ACME challenge (its own location) can never reach it.
    const serve = c.indexOf("location / {");
    expect(c.indexOf("if ($request_uri")).toBeGreaterThan(serve);
  });

  test("drops $uri/ when stripping slashes, or an index-less directory loops", async () => {
    // `$uri/` triggers nginx's own 301 adding the slash, which the strip rule 308s
    // straight back. Measured on OpenResty 1.27.1.1: `/dir-no-index` → 301 `/dir-no-index/`
    // → 308 `/dir-no-index` → …, `curl -L` exits 47. Probing `$uri/index.html` serves the
    // same directories without ever asking nginx to add a slash we then remove.
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...STATIC, trailingSlash: false });
    const c = appConf(conf);
    expect(c).toContain("try_files $uri $uri/index.html /index.html;");
    expect(c).not.toContain("$uri/ /index.html");
    expect(c).toContain('if ($request_uri ~ "^([^?]+)/([?].*)?$") {');
  });

  // As an unconditional `if`, enforcement redirected before anything checked whether the
  // path resolves, so `/LICENSE` 308'd to `/LICENSE/` and served the SPA index with a 200
  // — worse than a 404, since monitoring and crawlers see success. As a try_files fallback
  // it can only run once nothing resolved, which also makes it loop-free and lets it
  // coexist with cleanUrls.
  test("enforces the trailing slash only for a path that resolves to nothing", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...STATIC, trailingSlash: true });
    const c = appConf(conf);
    expect(c).toContain("try_files $uri $uri/ @osh_add_slash;");
    expect(c).toContain("location @osh_add_slash {");
    // A named location inherits nothing, so it must repeat `root` — without it
    // `try_files /index.html` serves OpenResty's stock welcome page, not the site.
    expect(c).toMatch(/location @osh_add_slash \{\n\s+root \/opt\/openship\/site;/);
    // Declines a path that already ends in `/`, so the retry falls through to the index
    // instead of bouncing again.
    expect(c).toContain('if ($request_uri ~ "^([^?]*[^/?])([?].*)?$") {');
    expect(c).toContain("return 308 $1/$2;");
    expect(c).not.toContain("return 308 $1$2/$3;"); // the old unconditional form
  });

  test("combines cleanUrls with slash enforcement, no special case needed", async () => {
    // `$uri.html` resolves `/about` before the fallback is reached, so the pair no longer
    // depends on the build emitting `about/index.html` — and enforcement no longer has to
    // be dropped outright to avoid that gamble.
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...STATIC, cleanUrls: true, trailingSlash: true });
    const c = appConf(conf);
    expect(c).toContain("try_files $uri $uri.html $uri/ @osh_add_slash;");
    expect(c).toContain("[.]html"); // cleanUrls kept
  });

  // A map variable is http-wide, and the name used to be a slug of the path — so several
  // `headers` entries for the SAME source (legal vercel.json) and paths that squash alike
  // (`/a-b/` vs `/a/b/`) shared one variable. nginx does NOT reject that: `map` registers
  // its variable as CHANGEABLE, `openresty -t` passes, and the last declaration wins — so
  // one header shipped a sibling rule's value and the other silently vanished.
  test("gives every path-scoped header its own map variable", async () => {
    const compiled = compileVercelRouting({
      headers: [
        { source: "/api/(.*)", headers: [{ key: "X-One", value: "1" }] },
        { source: "/api/(.*)", headers: [{ key: "X-Two", value: "2" }] },
        { source: "/a-b/", headers: [{ key: "X-Dash", value: "dash" }] },
        { source: "/a/b/", headers: [{ key: "X-Slash", value: "slash" }] },
      ],
    });
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, headerRules: compiled.headerRules });
    const c = appConf(conf);
    const names = [...c.matchAll(/map \$request_uri \$(osh_hdr_\w+)/g)].map((m) => m[1]);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    // Each add_header must read its OWN variable, in the same order.
    for (const [i, key] of ["X-One", "X-Two", "X-Dash", "X-Slash"].entries()) {
      expect(c).toContain(`add_header ${key} $${names[i]} always;`);
    }
    // The path lands in a regex, so an unescaped `.` would over-match.
    expect(c).toContain('~^/a-b/ "dash";');
  });

  test("escapes a dot in a path-scoped header's path", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({
      ...PROXY,
      headerRules: [{ path: "/v1.0/", headers: [{ key: "X-Ver", value: "1" }] }],
    });
    // Unescaped, `~^/v1.0/` would also fire on `/v1x0/`.
    expect(appConf(conf)).toContain('~^/v1[.]0/ "1";');
  });

  // Both sinks are nginx COMPLEX values, so `$name` expands: `"build-$BUILD_ID"` is
  // `[emerg] unknown "build_id" variable` (which costs the whole vhost), `"US $5 only"`
  // silently serves `US  only`, and `"$http_cookie"` would reflect request state.
  test("refuses a header value containing an nginx variable", async () => {
    const compiled = compileVercelRouting({
      headers: [
        { source: "/(.*)", headers: [{ key: "X-B", value: "build-$BUILD_ID" }] },
        { source: "/api/", headers: [{ key: "X-P", value: "US $5 only" }] },
      ],
    });
    expect(compiled.headerRules).toEqual([]);
    expect(compiled.skipped).toHaveLength(2);

    const { nginx } = setup();
    await expect(
      nginx.registerRoute({
        ...PROXY,
        headerRules: [{ path: "/api/", headers: [{ key: "X-B", value: "$http_cookie" }] }],
      }),
    ).rejects.toThrow(/variable/);
  });

  test("never applies the URL shape to a PROXIED route (the framework owns it)", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, cleanUrls: true, trailingSlash: false });
    const c = appConf(conf);
    expect(c).not.toContain("$request_uri ~");
    // The challenge location has a try_files of its own; the STATIC chain must be absent.
    expect(c).not.toContain("try_files $uri $uri");
  });

  test("emits today's exact chain when neither flag is set", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(STATIC);
    const c = appConf(conf);
    expect(c).toContain("try_files $uri $uri/ /index.html;");
    expect(c).not.toContain("$request_uri ~");
    expect(c).not.toContain("map ");
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
    expect(c).toContain("location ^~ /.well-known/acme-challenge/");
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
    expect(c).toContain(`location ^~ ${EDGE_CHALLENGE_URL_PREFIX} {`);
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
    for (const [status, expected] of [
      [302, 302],
      [308, 308],
      [200, 301],
    ] as const) {
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
    const sidecar = [...files.entries()].find(
      ([p]) => p.includes("www-example-com") && p.endsWith(".json"),
    );
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

/**
 * GH-570. An upstream defeats proxy buffering by answering with
 * `X-Accel-Buffering: no` — which nginx honours and then STRIPS, because the whole
 * X-Accel-* family is hidden from the downstream response by default. One hop, that
 * is invisible and correct. A Cloud-fronted `*.opsh.io` host has two, and the second
 * hop buffered the SSE this one had already let through.
 */
describe("NginxProvider SSE buffering passthrough", () => {
  const FREE: RouteConfig = {
    domain: "myapp.opsh.io",
    tls: false,
    targetUrl: "http://127.0.0.1:3009",
  };

  test("re-exposes X-Accel-Buffering so a second proxy hop sees it", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(FREE);
    expect(conf("myapp-opsh-io")).toContain("proxy_pass_header X-Accel-Buffering;");
  });

  test("carries it on a TLS vhost as well as a plain one", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute(OURS);
    expect(conf("app-example-com")).toContain("proxy_pass_header X-Accel-Buffering;");
  });

  /** Without a generation bump the directive reaches only boxes that redeploy. */
  test("is stamped at a generation that supersedes the pre-passthrough vhosts", () => {
    expect(VHOST_GENERATION).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The ACME design has exactly one moving part, and this is its failure.
 *
 * Issuance is EDGE-DRIVEN: Let's Encrypt hits :80, the edge proxies
 * `/.well-known/acme-challenge/` to certbot's transient standalone server on a fixed loopback
 * port. No port-80 fight, no webroot, no DNS-01 — one path. Certbot holds that port only while
 * issuing, and nothing else in the design binds it.
 *
 * When the bind fails, the operator used to get certbot's wall verbatim — "Saving debug log to
 * /var/log/letsencrypt/letsencrypt.log · Could not bind TCP port 49180 … · Ask for help at
 * community.letsencrypt.org" — because no branch matched and the fallback prints the last three
 * lines. Which is precisely the opener `summarizeCertbotFailure` exists to replace.
 */
describe("a failed challenge-listener bind is diagnosed, not dumped", () => {
  const raw = [
    "Saving debug log to /var/log/letsencrypt/letsencrypt.log",
    "Could not bind TCP port 49180 because it is already in use by another process on this system (such as a web server). Please stop the program in question and then try again.",
    "Ask for help or search for solutions at https://community.letsencrypt.org.",
  ].join("\n");

  test("names the port and what actually holds it", () => {
    const msg = summarizeCertbotFailure(raw, "api.example.com");
    expect(msg).toContain("49180");
    expect(msg).toContain("earlier attempt");
  });

  test("says it is NOT a DNS or routing problem", () => {
    // The failure precedes any validation attempt, so every other diagnosis in this function
    // would send the operator after something that was never tried.
    const msg = summarizeCertbotFailure(raw, "api.example.com");
    expect(msg).toContain("not a DNS or routing problem");
    expect(msg).not.toContain("isn't reachable from the internet");
    expect(msg).not.toContain("doesn't resolve to this server");
  });

  test("gives a command that finds the holder", () => {
    expect(summarizeCertbotFailure(raw, "api.example.com")).toContain("ss -ltnp");
  });

  test("drops certbot's opener and its community-forum footer", () => {
    const msg = summarizeCertbotFailure(raw, "api.example.com");
    expect(msg).not.toContain("Saving debug log");
    expect(msg).not.toContain("community.letsencrypt.org");
  });

  test("wins over the reachability branch, which the same output would also match", () => {
    // "already in use ... such as a web server" is close enough to the :80 story that ordering
    // is what keeps them apart — the bind check must come first.
    const withTimeout = `${raw}\nTimeout during connect (likely firewall problem)`;
    expect(summarizeCertbotFailure(withTimeout, "api.example.com")).toContain("49180");
  });

  test("also recognises certbot's other wording for the same failure", () => {
    for (const line of [
      "Problem binding to port 49180: Could not bind to IPv4 or IPv6.",
      "Address already in use",
    ]) {
      expect(summarizeCertbotFailure(line, "api.example.com"), line).toContain("49180");
    }
  });
});

/**
 * One definition of "certbot failed to BIND", shared by the diagnosis and by the live probe at
 * the issuance site. Two copies of that regex drift into a message naming the wrong cause, or a
 * probe that runs on the wrong failure.
 */
describe("isAcmePortBindFailure", () => {
  test("matches every wording certbot has used for it", () => {
    for (const line of [
      "Could not bind TCP port 49180 because it is already in use by another process on this system",
      "Problem binding to port 49180: Could not bind to IPv4 or IPv6.",
      "OSError: [Errno 98] Address already in use",
    ]) {
      expect(isAcmePortBindFailure(line), line).toBe(true);
    }
  });

  test("does not match a validation failure", () => {
    // These must fall through to the branches that DID try to validate — the whole reason the
    // bind check is ordered first.
    for (const line of [
      "Timeout during connect (likely firewall problem)",
      "DNS problem: NXDOMAIN looking up A for api.example.com",
      "Invalid response from http://api.example.com/.well-known/acme-challenge/x: 404",
      "",
    ]) {
      expect(isAcmePortBindFailure(line), JSON.stringify(line)).toBe(false);
    }
  });

  test("the diagnosis branch is driven by it, not by its own copy of the regex", () => {
    // Guards the pair: if the branch grew a private regex, this file's other suite would still
    // pass while the probe gate silently disagreed.
    const src = readFileSync(new URL("./nginx.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("if (isAcmePortBindFailure(text)) {");
    expect(code).toContain("isAcmePortBindFailure(raw) && this.executor");
    // Exactly one place spells the pattern out.
    expect((code.match(/could not bind \(\?:tcp \)\?port/g) ?? []).length).toBe(1);
  });
});
