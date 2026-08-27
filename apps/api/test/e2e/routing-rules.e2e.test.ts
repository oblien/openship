/**
 * `vercel.json` routing rules, end to end, against a real OpenResty.
 *
 * This is the only thing that proves a rule in a repo's config actually CHANGES WHAT A
 * VISITOR GETS. Everything else in the suite asserts on config TEXT — that the vhost
 * contains an `if ($request_uri ~ …)`, that a capture is spelled a certain way — and text
 * assertions were green for every one of the defects below:
 *
 *   - `{"source":"/(.*)","destination":"https://…"}` (one of Vercel's own documented
 *     examples) emitted a SECOND `location /`. `[emerg] duplicate location "/"`, the
 *     reload is refused, and for a brand-new domain the rollback DELETES the file — so the
 *     domain had no vhost at all. Every text assertion still passed.
 *   - `{"source":"/(.*).html","destination":"/$1"}` on a static site 308'd EVERY path to
 *     `/index`, forever: a regex location matches `$uri`, which `index`/`try_files` rewrite
 *     internally, so the rule fired on nginx's own `/index.html`.
 *   - A compiled catch-all out-ranked `location /_openship/hooks/` and the composite
 *     `/api/` backend (a regex location beats any plain prefix), so GitHub deliveries and
 *     authenticated API traffic went to whatever origin the repo named.
 *   - `trailingSlash:false` put any index-less directory in a 301↔308 loop.
 *   - `trailingSlash:true` made a real extension-less file (`/LICENSE`) unreachable,
 *     serving the SPA index with a 200 — worse than a 404, because monitoring sees success.
 *   - Two `headers` entries for the same source shared one http-scope `map` variable, so
 *     one header shipped the other's value. `openresty -t` does NOT reject that (`map`
 *     registers its variable CHANGEABLE), which is exactly why it was silent.
 *
 * So: the REAL compiler and the REAL emitter produce the config, real OpenResty loads it,
 * and real requests are asked what happened. The `openresty -t` inside the container makes
 * this the pre-merge equivalent of the Dockerfile's gate; the negative control at the end
 * proves the gate can still go red, since a container test that quietly stopped exercising
 * anything looks identical to a passing one.
 *
 * Config text travels in the container's own command as quoted heredocs rather than a bind
 * mount, for the reason the sibling edge test documents: a mount only works when the daemon
 * can see the host path, which is false for a macOS temp dir (and, measured here, for
 * `/private/tmp` under Docker Desktop) and true in CI — the one setup where a gate must not
 * evaporate.
 *
 * The vhosts are HTTP-only (`tls: false`), which keeps certificates out of a test about
 * routing. Lua is the REAL scripts, copied in, because the generated vhost references them
 * and a missing one makes OpenResty error on every request.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 * See test/helpers/docker-e2e.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DockerRuntime,
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  compileVercelRouting,
  type CommandExecutor,
  type RootChecked,
  type RouteConfig,
} from "@repo/adapters";
import type { RoutingConfig } from "@repo/core";
import type Dockerode from "dockerode";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LUA_SRC = join(REPO_ROOT, "packages/adapters/src/infra/lua");
const LUA_DEST = "/usr/local/openresty/site/lualib/openship";
const SITES_DIR = OPENRESTY_DEFAULT_PATHS.sitesDir;
const CONF_PATH = `${OPENRESTY_DEFAULT_PATHS.confDir}/nginx.conf`;
/** Must be under /opt/openship — `assertValidStaticRoot` refuses anything else. */
const WWW = "/opt/openship/www";

/** `cat > path <<'EOF'` — quoted delimiter, so nothing in the body is expanded. */
function heredoc(path: string, content: string): string {
  const delim = "OSH_EOF_r3k9";
  if (content.includes(delim)) throw new Error(`heredoc delimiter collides: ${path}`);
  return `cat > ${path} <<'${delim}'\n${content}\n${delim}\n`;
}

/** The image the edge is built FROM, read from the Dockerfile so a base bump cannot leave
 *  this testing a version nothing ships. */
async function edgeBaseImage(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "apps/edge/Dockerfile"), "utf8");
  const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  if (!from) throw new Error("apps/edge/Dockerfile has no FROM line");
  return from;
}

/**
 * Render a vhost with the REAL `NginxProvider`.
 *
 * Only the TRANSPORT is faked — an in-memory file map plus the atomic-rename `mv` the
 * provider performs. The config text is the product's, which is the entire point: a test
 * that hand-wrote the nginx would prove nothing about what a deploy emits.
 */
async function renderVhost(route: RouteConfig): Promise<string> {
  const files = new Map<string, string>();
  const executor = {
    exec: async (command: string): Promise<string> => {
      // Path detection re-runs on reload; failing it keeps the injected sitesDir.
      if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty here");
      const mv = command.match(/^mv '([^']+)' '([^']+)'$/);
      if (mv) {
        const v = files.get(mv[1]);
        if (v !== undefined) {
          files.set(mv[2], v);
          files.delete(mv[1]);
        }
      }
      return "";
    },
    writeFile: async (p: string, c: string) => void files.set(p, c),
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) => files.has(p),
    mkdir: async () => {},
    rm: async (p: string) => void files.delete(p),
  } as unknown as RootChecked;

  // These files are loaded by the container edge booted below. Model that real
  // target so registerRoute uses the container reload contract; the in-memory
  // transport intentionally has no bare-host process to discover or signal.
  const nginx = new NginxProvider({
    paths: OPENRESTY_DEFAULT_PATHS,
    executor,
    containerEdge: true,
    pinPaths: true,
  });
  await nginx.registerRoute(route);
  const conf = [...files.entries()].find(([p]) => p.endsWith(".conf"));
  if (!conf) throw new Error(`registerRoute wrote no vhost for ${route.domain}`);
  return conf[1];
}

/** A static route on `<name>.test`, with the compiled rules of a real vercel.json. */
async function staticSite(name: string, routing: RoutingConfig): Promise<string> {
  const c = compileVercelRouting(routing);
  // A rule silently dropped instead of applied would make the assertions below lie.
  expect(c.skipped, `unexpected skipped rules for ${name}: ${c.skipped.join("; ")}`).toEqual([]);
  return renderVhost({
    domain: `${name}.test`,
    tls: false,
    staticRoot: WWW,
    ...(c.redirects.length ? { redirects: c.redirects } : {}),
    ...(c.headerRules.length ? { headerRules: c.headerRules } : {}),
    ...(c.cleanUrls ? { cleanUrls: true } : {}),
    ...(c.trailingSlash === undefined ? {} : { trailingSlash: c.trailingSlash }),
  } as unknown as RouteConfig);
}

interface Answer {
  status: number;
  location?: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** One request with an explicit `Host`, which `fetch` refuses to set. */
function ask(port: number, path: string, host: string): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    // Without this a stalled response hangs until vitest's timeout, which reports as
    // "the test took 300s" and names nothing.
    req.setTimeout(15_000, () => req.destroy(new Error(`timed out: ${host}${path}`)));
    req.on("error", reject);
    req.end();
  });
}

/** Follow redirects by hand — `Location` names a hostname no resolver knows, and a chain
 *  that fails to terminate is the bug, so the hop budget has to be ours. */
async function follow(
  port: number,
  path: string,
  host: string,
  max = 6,
): Promise<{ hops: string[]; final: Answer }> {
  const hops: string[] = [];
  let at = path;
  for (let i = 0; i <= max; i++) {
    const answer = await ask(port, at, host);
    if (answer.status < 300 || answer.status >= 400 || !answer.location) {
      return { hops, final: answer };
    }
    hops.push(answer.location);
    const next = answer.location.replace(/^https?:\/\/[^/]+/, "");
    // A rule that redirects a path to ITSELF is the classic loop; stop and let the
    // assertion report the chain rather than spinning to the budget.
    if (next === at) return { hops, final: answer };
    at = next;
  }
  throw new Error(`redirect chain did not terminate for ${host}${path}: ${hops.join(" -> ")}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDockerE2E("vercel.json routing rules, real OpenResty", () => {
  let runtime: DockerRuntime;
  let image = "";
  let lua: Record<string, string> = {};
  let port = 0;
  const started: Dockerode.Container[] = [];

  /**
   * `http {}` envelope plus the upstream stand-ins.
   *
   * The stand-ins answer with their own port and the URI they RECEIVED, which is what makes
   * "did the rewrite reach the right backend with the right path" observable rather than
   * inferred. They live here, on their own ports, so one container covers the whole matrix.
   */
  const ENVELOPE = `
worker_processes 1;
error_log stderr warn;
events { worker_connections 128; }
http {
    include       ${OPENRESTY_DEFAULT_PATHS.confDir}/mime.types;
    default_type  application/octet-stream;
    access_log off;
    lua_package_path "/usr/local/openresty/site/lualib/?.lua;;";

    server { listen 9901; location / { return 200 "APP uri=$request_uri\\n"; } }
    server { listen 9902; location / { return 200 "THIRDPARTY uri=$request_uri host=$http_host\\n"; } }
    server { listen 9903; location / { return 200 "WEBHOOK uri=$request_uri\\n"; } }
    server { listen 9904; location / { return 200 "BACKEND uri=$request_uri host=$http_host\\n"; } }

    include ${SITES_DIR}/*.conf;
}
`;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    image = await edgeBaseImage();
    await runtime.pullImage(image);
    // The REAL scripts: the generated vhost references rules_guard/site_logger, and a
    // missing file makes OpenResty error on every request instead of routing it.
    const names = (await readdir(LUA_SRC)).filter((f) => f.endsWith(".lua"));
    lua = Object.fromEntries(
      await Promise.all(names.map(async (f) => [f, await readFile(join(LUA_SRC, f), "utf8")])),
    );
    port = await bootAll();
  }, 600_000);

  afterAll(async () => {
    for (const c of started) await c.remove({ force: true }).catch(() => {});
    await runtime?.dispose().catch(() => {});
  });

  /** Every vhost under test, one per hostname, in ONE container. */
  async function vhosts(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    // #510 itself: a wildcard whose destination refers back to the capture.
    out["blog"] = await staticSite("blog", {
      redirects: [{ source: "/blog/:path*", destination: "/news/:path*", permanent: true }],
    });

    // The whole-site loop: matches nginx's OWN internal `/index.html` rewrite.
    out["htmlredir"] = await staticSite("htmlredir", {
      redirects: [{ source: "/(.*).html", destination: "/$1", permanent: true }],
    });

    // Capture-FREE destination on a root source — the duplicate `location /`.
    out["rootall"] = await staticSite("rootall", {
      redirects: [{ source: "/(.*)", destination: "https://example.com/docs" }],
    });

    // vercel.json is first-match-wins; the narrower rule is FIRST.
    out["order"] = await staticSite("order", {
      redirects: [
        { source: "/docs/legacy/:p*", destination: "/archive", permanent: true },
        { source: "/docs/:p*", destination: "/documentation/:p*", permanent: true },
      ],
    });

    out["strip"] = await staticSite("strip", { trailingSlash: false });
    out["enforce"] = await staticSite("enforce", { trailingSlash: true });
    out["clean"] = await staticSite("clean", { cleanUrls: true });

    // Two rules on the SAME source, plus two paths that used to squash to one variable.
    out["hdrs"] = await staticSite("hdrs", {
      headers: [
        { source: "/(.*)", headers: [{ key: "X-Global", value: "g" }] },
        { source: "/api/(.*)", headers: [{ key: "X-One", value: "1" }] },
        { source: "/api/(.*)", headers: [{ key: "X-Two", value: "2" }] },
        { source: "/a-b/", headers: [{ key: "X-Dash", value: "dash" }] },
        { source: "/a/b/", headers: [{ key: "X-Slash", value: "slash" }] },
      ],
    });

    // A catch-all rewrite on a vhost that ALSO carries our webhook location and a
    // composite backend — the precedence case that leaked signed payloads.
    out["hooks"] = await renderVhost({
      domain: "hooks.test",
      tls: false,
      targetUrl: "http://127.0.0.1:9901",
      webhookProxy: "http://127.0.0.1:9903",
      proxyLocations: [
        { pathPrefix: "/api/", targetUrl: "http://127.0.0.1:9904" },
        {
          pathPrefix: "/",
          targetUrl: "http://127.0.0.1:9902",
          pattern: "/(.*)",
          upstreamPath: "/x/$1",
        },
      ],
    } as unknown as RouteConfig);

    return out;
  }

  /** Boot one container holding every vhost; return the published :80 port. */
  async function bootAll(): Promise<number> {
    const confs = await vhosts();
    const script =
      `set -e\n` +
      `mkdir -p ${SITES_DIR} ${LUA_DEST} ${WWW}/docs ${WWW}/dir-no-index /var/www/acme/oblien\n` +
      heredoc(CONF_PATH, ENVELOPE) +
      Object.entries(lua)
        .map(([name, body]) => heredoc(join(LUA_DEST, name), body))
        .join("") +
      // Static fixtures. Distinct bodies so "which file answered" is observable.
      // `heredoc` terminates each file with a newline, hence the `.trim()` on body asserts.
      heredoc(`${WWW}/index.html`, "ROOT-INDEX") +
      heredoc(`${WWW}/about.html`, "ABOUT-HTML") +
      heredoc(`${WWW}/docs/index.html`, "DOCS-INDEX") +
      heredoc(`${WWW}/dir-no-index/post.html`, "POST") +
      // Extension-less REAL file: what slash-enforcement used to shadow.
      heredoc(`${WWW}/LICENSE`, "LICENSE-TEXT") +
      Object.entries(confs)
        .map(([name, body]) => heredoc(join(SITES_DIR, `${name}.conf`), body))
        .join("") +
      `openresty -t\n` +
      `exec openresty -g 'daemon off;'\n`;

    const container = await runtime.docker.createContainer({
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [script],
      Tty: true,
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        AutoRemove: false,
      },
    });
    started.push(container);
    await container.start();

    const info = await container.inspect();
    const bound = info.NetworkSettings.Ports?.["80/tcp"]?.[0]?.HostPort;
    if (!bound) throw new Error("docker published no host port for 80/tcp");
    const p = Number(bound);

    for (let i = 0; i < 80; i++) {
      const state = await container.inspect();
      if (!state.State.Running) {
        const log = (await container.logs({ stdout: true, stderr: true, tail: 60 })).toString();
        // A config OpenResty rejects lands here with its own [emerg] line, rather than
        // as an unexplained connection refused.
        throw new Error(`edge exited (${state.State.ExitCode}):\n${log}`);
      }
      try {
        await ask(p, "/", "blog.test");
        return p;
      } catch {
        await sleep(250);
      }
    }
    throw new Error("edge never answered on :80");
  }

  // ── The rule this whole change exists for ────────────────────────────────────

  it("carries a wildcard capture into the redirect, with the query string", async () => {
    // The bug: served from a prefix location, `$1` expanded to empty and every visitor
    // landed on a literal `/news/`.
    expect((await ask(port, "/blog/hello", "blog.test")).location).toBe(
      "http://blog.test/news/hello",
    );
    expect((await ask(port, "/blog/a/b/c", "blog.test")).location).toBe(
      "http://blog.test/news/a/b/c",
    );
    // Vercel preserves the query on a redirect; the old `return <dest>;` dropped it, and a
    // greedy capture would append it TWICE.
    expect((await ask(port, "/blog/hello?x=1&y=2", "blog.test")).location).toBe(
      "http://blog.test/news/hello?x=1&y=2",
    );
    expect((await ask(port, "/blog/hello", "blog.test")).status).toBe(308);
  });

  it("evaluates redirects in vercel.json order, not by specificity", async () => {
    // As locations, the later/broader rule became a regex and out-ranked the earlier,
    // narrower prefix one — the inverse of first-match-wins.
    expect((await ask(port, "/docs/legacy/x", "order.test")).location).toBe(
      "http://order.test/archive",
    );
    expect((await ask(port, "/docs/other", "order.test")).location).toBe(
      "http://order.test/documentation/other",
    );
  });

  // ── The outages ──────────────────────────────────────────────────────────────

  it("serves a root-level catch-all instead of failing to load the vhost", async () => {
    // The config LOADING at all is the assertion: this shape emitted a second
    // `location /`, so the reload was refused and the domain had no vhost.
    for (const path of ["/", "/anything", "/deep/path"]) {
      const a = await ask(port, path, "rootall.test");
      expect(a.status).toBe(308);
      expect(a.location).toBe("https://example.com/docs");
    }
  });

  it("does not loop a static site whose rule matches nginx's own internal rewrite", async () => {
    // Every one of these used to 308 to `/index` and keep going.
    for (const path of ["/", "/about", "/nope", "/docs/"]) {
      const { hops, final } = await follow(port, path, "htmlredir.test");
      expect({ path, hops, status: final.status }).toEqual({ path, hops: [], status: 200 });
    }
    // The rule itself still works for what the CLIENT actually asked for.
    expect((await ask(port, "/about.html", "htmlredir.test")).location).toBe(
      "http://htmlredir.test/about",
    );
  });

  it("strips the trailing slash without looping on an index-less directory", async () => {
    // `$uri/` triggered nginx's own 301 adding the slash, which the strip rule 308'd
    // straight back: `curl -L` exited 47.
    const { hops, final } = await follow(port, "/dir-no-index", "strip.test");
    expect(hops).toEqual([]);
    expect(final.status).toBe(200);

    // `/a/` → `/a`, one hop, and a directory WITH an index still serves.
    const canonical = await follow(port, "/docs/", "strip.test");
    expect(canonical.hops).toEqual(["http://strip.test/docs"]);
    expect(canonical.final.body.trim()).toBe("DOCS-INDEX");
    // The bare root must not be redirected to the empty string.
    expect((await ask(port, "/", "strip.test")).status).toBe(200);
  });

  it("enforces the trailing slash only for a path that resolves to nothing", async () => {
    // The bug: `/LICENSE` 308'd to `/LICENSE/` and served the SPA index with a 200.
    const license = await ask(port, "/LICENSE", "enforce.test");
    expect(license.status).toBe(200);
    expect(license.body.trim()).toBe("LICENSE-TEXT");

    // A path that resolves to nothing gets the slash, then terminates on the index —
    // and from the SITE's root, not OpenResty's stock welcome page (the named location
    // inherits no `root`, which is a bug this test caught).
    const missing = await follow(port, "/nope", "enforce.test");
    expect(missing.hops).toEqual(["http://enforce.test/nope/"]);
    expect(missing.final.body.trim()).toBe("ROOT-INDEX");

    // A real directory is canonicalised by nginx itself.
    expect((await ask(port, "/docs", "enforce.test")).location).toBe("http://enforce.test/docs/");
  });

  it("serves clean URLs and canonicalises the .html form", async () => {
    expect((await ask(port, "/about", "clean.test")).body.trim()).toBe("ABOUT-HTML");
    expect((await ask(port, "/about.html", "clean.test")).location).toBe("http://clean.test/about");
    const { hops, final } = await follow(port, "/", "clean.test");
    expect(hops).toEqual([]);
    expect(final.body.trim()).toBe("ROOT-INDEX");
  });

  // ── The silent one ───────────────────────────────────────────────────────────

  it("gives every path-scoped header rule its own value", async () => {
    // Two rules on one source, and two paths that squashed to the same variable name,
    // used to share one `map` — last declaration wins, so one header shipped the other's
    // value and the other vanished. `openresty -t` accepts the duplicate, which is why
    // only a real response could catch this.
    const api = await ask(port, "/api/thing", "hdrs.test");
    expect(api.headers["x-one"]).toBe("1");
    expect(api.headers["x-two"]).toBe("2");

    const dash = await ask(port, "/a-b/x", "hdrs.test");
    expect(dash.headers["x-dash"]).toBe("dash");
    expect(dash.headers["x-slash"]).toBeUndefined();

    const slash = await ask(port, "/a/b/x", "hdrs.test");
    expect(slash.headers["x-slash"]).toBe("slash");
    expect(slash.headers["x-dash"]).toBeUndefined();

    // Global applies everywhere; path-scoped rules are absent off their path.
    for (const path of ["/", "/api/thing", "/a-b/x"]) {
      expect((await ask(port, path, "hdrs.test")).headers["x-global"]).toBe("g");
    }
    const other = await ask(port, "/somewhere-else", "hdrs.test");
    expect(other.headers["x-one"]).toBeUndefined();
    expect(other.headers["x-dash"]).toBeUndefined();
  });

  // ── Precedence: our own locations must out-rank a repo's rules ───────────────

  it("keeps the webhook and the composite backend out of a catch-all's reach", async () => {
    // A regex location beats any plain prefix, so the catch-all swallowed both: the
    // delivery (with its X-Hub-Signature) and authenticated /api traffic were proxied to
    // the third-party origin the repo named.
    expect((await ask(port, "/_openship/hooks/github", "hooks.test")).body).toContain(
      "WEBHOOK uri=/_openship/hooks/github",
    );
    const api = await ask(port, "/api/thing", "hooks.test");
    expect(api.body).toContain("BACKEND uri=/api/thing");
    // An upstream of OURS keeps our Host, not the origin's.
    expect(api.body).toContain("host=hooks.test");

    // The catch-all still catches everything nothing else claimed, rewritten as asked.
    expect((await ask(port, "/anything", "hooks.test")).body).toContain(
      "THIRDPARTY uri=/x/anything",
    );
    expect((await ask(port, "/deep/a/b?q=1", "hooks.test")).body).toContain(
      "THIRDPARTY uri=/x/deep/a/b?q=1",
    );
  });

  it("leaves the ACME challenge reachable on every host, catch-all or not", async () => {
    // `^~` is load-bearing: without it a compiled `/(.*)` swallowed the challenge and no
    // certificate for the host could ever issue. 502 = the request REACHED the certbot
    // proxy location (nothing is listening on the alt-port in this container); a 30x or a
    // 200 from the app would mean it was hijacked.
    for (const host of ["rootall.test", "blog.test", "hooks.test", "htmlredir.test"]) {
      const a = await ask(port, "/.well-known/acme-challenge/tok123", host);
      expect({ host, status: a.status }).toEqual({ host, status: 502 });
    }
  });

  // ── Negative control ─────────────────────────────────────────────────────────

  it("would have FAILED on the pre-fix emission shape", async () => {
    // Proves the gate can still go red. A redirect emitted as its own `location /` — what
    // a capture-free root catch-all used to produce — is rejected by OpenResty, so this
    // test would have caught it. A container suite that quietly stopped exercising
    // anything looks exactly like a passing one.
    const broken = `server {
    listen 80;
    server_name broken.test;
    location / {
        return 308 https://example.com/docs;
    }
    location / {
        root ${WWW};
        try_files $uri /index.html;
    }
}`;
    const container = await runtime.docker.createContainer({
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [
        `mkdir -p ${SITES_DIR}\n` +
          heredoc(CONF_PATH, ENVELOPE) +
          heredoc(join(SITES_DIR, "broken.conf"), broken) +
          `openresty -t\n`,
      ],
      Tty: true,
    });
    started.push(container);
    await container.start();
    const exit = await container.wait();
    const log = (await container.logs({ stdout: true, stderr: true, tail: 30 })).toString();
    expect(exit.StatusCode, `openresty accepted a duplicate location:\n${log}`).not.toBe(0);
    expect(log).toContain('duplicate location "/"');
  }, 120_000);
});
