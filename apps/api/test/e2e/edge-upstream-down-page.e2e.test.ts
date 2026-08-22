/**
 * The upstream-down page (#556), against a real OpenResty.
 *
 * Its siblings cover the two halves this cannot: `edge-upstream-down.test.ts` asserts the
 * page's bytes survive nginx's tokenizer, and `nginx.test.ts` asserts the handler lands in
 * the vhosts that proxy and no others. Both read config TEXT. Neither can answer the two
 * questions that actually decide whether the fix works:
 *
 *   - Does OpenResty ACCEPT a project vhost carrying ~2 KB of inlined HTML? Nothing on a PR
 *     builds `apps/edge/Dockerfile`, so `RUN openresty -t` there would find a broken page at
 *     release time, on a build whose failure mode is every routed site on the box going down.
 *   - Does a visitor actually GET the page, with the right status? The handler deliberately
 *     omits `=` before the named location so an intercepted 504 stays a 504 — a claim about
 *     nginx's behaviour, not about our string, and one a text assertion cannot make.
 *
 * The third case here is the one most worth having. `proxy_intercept_errors` is off by
 * default, which is why an app that answers 502 ITSELF keeps its own body instead of being
 * replaced by our page. That default is inherited, not written down in any vhost, so a
 * future `proxy_intercept_errors on;` added for an unrelated reason would silently start
 * masking every real error response from every app on the box. This test is what fails then.
 *
 * Vhosts come from the REAL `NginxProvider` — a hand-written nginx block would prove nothing
 * about what a deploy emits. Config text travels as quoted heredocs rather than a bind mount,
 * for the reason `edge-not-found-page.e2e.test.ts` documents: a mount needs the daemon to see
 * the host path, which is false under Colima and true in CI.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 * See test/helpers/docker-e2e.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DockerRuntime,
  EDGE_UPSTREAM_DOWN_SENTINEL,
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  type RootChecked,
  type RouteConfig,
} from "@repo/adapters";
import type Dockerode from "dockerode";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LUA_SRC = join(REPO_ROOT, "packages/adapters/src/infra/lua");
const LUA_DEST = "/usr/local/openresty/site/lualib/openship";
const SITES_DIR = OPENRESTY_DEFAULT_PATHS.sitesDir;
const CONF_PATH = `${OPENRESTY_DEFAULT_PATHS.confDir}/nginx.conf`;
/** Must be under /opt/openship — `assertValidStaticRoot` refuses anything else. */
const WWW = "/opt/openship/www";

/** Ports the envelope's upstream stand-ins listen on. 9911 is deliberately UNUSED. */
const PORT_DEAD = 9911;
const PORT_HANG = 9912;
const PORT_OWN_502 = 9913;
const PORT_HEALTHY = 9914;

/** `cat > path <<'EOF'` — quoted delimiter, so nothing in the body is expanded. */
function heredoc(path: string, content: string): string {
  const delim = "OSH_EOF_c3d9";
  if (content.includes(delim)) throw new Error(`heredoc delimiter collides: ${path}`);
  return `cat > ${path} <<'${delim}'\n${content}\n${delim}\n`;
}

/** The image the edge is built FROM, read from the Dockerfile so a base bump can't leave
 *  this testing a version nothing ships. */
async function edgeBaseImage(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "apps/edge/Dockerfile"), "utf8");
  const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  if (!from) throw new Error("apps/edge/Dockerfile has no FROM line");
  return from;
}

/**
 * Render a vhost with the REAL `NginxProvider`. Only the TRANSPORT is faked — an in-memory
 * file map plus the atomic-rename `mv` the provider performs.
 */
async function renderVhost(route: RouteConfig): Promise<string> {
  const files = new Map<string, string>();
  const executor = {
    exec: async (command: string): Promise<string> => {
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

  const nginx = new NginxProvider({ paths: OPENRESTY_DEFAULT_PATHS, executor });
  await nginx.registerRoute(route);
  const conf = [...files.entries()].find(([p]) => p.endsWith(".conf"));
  if (!conf) throw new Error(`registerRoute wrote no vhost for ${route.domain}`);
  return conf[1];
}

interface Answer {
  status: number;
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
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    // Without this a stalled response hangs until vitest's own timeout, which reports as
    // "the test took 300s" and names nothing.
    req.setTimeout(20_000, () => req.destroy(new Error(`timed out: ${host}${path}`)));
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDockerE2E("edge upstream-down page, real OpenResty", () => {
  let runtime: DockerRuntime;
  let image = "";
  let lua: Record<string, string> = {};
  let port = 0;
  const started: Dockerode.Container[] = [];

  /**
   * `http {}` envelope plus the upstream stand-ins that produce each failure mode.
   *
   * `PORT_DEAD` is intentionally absent — a refused connection is how nginx generates a 502,
   * and it is the exact shape of a container that crashed or has not booted yet.
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

    # Accepts the connection and never answers → a read timeout, i.e. nginx's own 504.
    server { listen ${PORT_HANG}; location / { content_by_lua_block { ngx.sleep(10) } } }
    # An app that answers 502 ITSELF. Its body must reach the client untouched.
    server { listen ${PORT_OWN_502}; location / { return 502 "BODY-FROM-APP"; } }
    # A healthy app, so "the page never fires on a working request" is observable.
    server { listen ${PORT_HEALTHY}; location / { return 200 "BODY-FROM-HEALTHY-APP"; } }

    include ${SITES_DIR}/*.conf;
}
`;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    image = await edgeBaseImage();
    await runtime.pullImage(image);
    // The REAL scripts: a generated vhost references rules_guard/site_logger, and a missing
    // file makes OpenResty error on every request instead of routing it.
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
    return {
      dead: await renderVhost({
        domain: "dead.test",
        tls: false,
        targetUrl: `http://127.0.0.1:${PORT_DEAD}`,
      }),
      // 1s read timeout so the 504 arm costs a second instead of nginx's 60s default.
      slow: await renderVhost({
        domain: "slow.test",
        tls: false,
        targetUrl: `http://127.0.0.1:${PORT_HANG}`,
        proxy: { proxyConnectTimeout: "1s", proxyReadTimeout: "1s" },
      }),
      appown: await renderVhost({
        domain: "appown.test",
        tls: false,
        targetUrl: `http://127.0.0.1:${PORT_OWN_502}`,
      }),
      healthy: await renderVhost({
        domain: "healthy.test",
        tls: false,
        targetUrl: `http://127.0.0.1:${PORT_HEALTHY}`,
      }),
      // No upstream at all: the page must not be in this vhost, so a missing file stays the
      // plain 404 it has always been.
      staticsite: await renderVhost({ domain: "staticsite.test", tls: false, staticRoot: WWW }),
    };
  }

  /** Boot one container holding every vhost; return the published :80 port. */
  async function bootAll(): Promise<number> {
    const confs = await vhosts();
    const script =
      `set -e\n` +
      `mkdir -p ${SITES_DIR} ${LUA_DEST} ${WWW} /var/www/acme/oblien\n` +
      heredoc(CONF_PATH, ENVELOPE) +
      Object.entries(lua)
        .map(([name, body]) => heredoc(join(LUA_DEST, name), body))
        .join("") +
      heredoc(`${WWW}/index.html`, "STATIC-INDEX") +
      Object.entries(confs)
        .map(([name, body]) => heredoc(join(SITES_DIR, `${name}.conf`), body))
        .join("") +
      // The pre-merge equivalent of the Dockerfile's gate: a page that broke the tokenizer
      // fails HERE, with its own [emerg] line, instead of at release time.
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
    const published = Number(bound);

    // Ready when it answers, dead when it exits — and a dead edge must report the reason
    // OpenResty gave, not a timeout.
    for (let i = 0; i < 60; i++) {
      const state = await container.inspect();
      if (!state.State.Running) {
        const log = (await container.logs({ stdout: true, stderr: true, tail: 40 })).toString();
        throw new Error(`edge exited (${state.State.ExitCode}):\n${log}`);
      }
      try {
        await ask(published, "/", "healthy.test");
        return published;
      } catch {
        await sleep(250);
      }
    }
    throw new Error("edge never answered on :80");
  }

  it("a refused upstream answers 502 with OUR page, not OpenResty's", async () => {
    const res = await ask(port, "/", "dead.test");
    expect(res.status).toBe(502);
    expect(res.body).toContain(EDGE_UPSTREAM_DOWN_SENTINEL);
    expect(res.body).toContain("Application unavailable");
    // The stock page is what the report was about: it is what a Cloud-fronted visitor saw
    // on the operator's own domain.
    expect(res.body).not.toContain("<center>502 Bad Gateway</center>");
    expect(res.body).not.toMatch(/openresty\/\d/);
    // No link at all — the whole point of the report.
    expect(res.body).not.toMatch(/https?:\/\//);
    expect(res.body).not.toContain("<a ");
  });

  it("a read timeout keeps its 504 — the handler omits `=` on purpose", async () => {
    // With `error_page 502 504 = @loc;` this would arrive as whatever the named location's
    // own `return` says, and a timeout would stop being reportable as a timeout. This is the
    // assertion that pins the semantics in the real server rather than in a comment.
    const res = await ask(port, "/", "slow.test");
    expect(res.status).toBe(504);
    expect(res.body).toContain(EDGE_UPSTREAM_DOWN_SENTINEL);
  }, 60_000);

  it("an app's OWN 502 passes through untouched", async () => {
    // `proxy_intercept_errors` is off by default and set nowhere in this repo. If that ever
    // changes, this page starts masking every real error response from every app on the box
    // — and this is the test that catches it.
    const res = await ask(port, "/", "appown.test");
    expect(res.status).toBe(502);
    expect(res.body).toBe("BODY-FROM-APP");
    expect(res.body).not.toContain(EDGE_UPSTREAM_DOWN_SENTINEL);
  });

  it("a healthy app is untouched", async () => {
    const res = await ask(port, "/", "healthy.test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("BODY-FROM-HEALTHY-APP");
  });

  it("answers text/html even when the URI looks like a stylesheet", async () => {
    // `return` with a body types the response from the request URI, so without the empty
    // `types { }` map a down app's `/app.css` would be `Content-Type: text/css` holding HTML
    // — which browsers drop silently instead of rendering.
    const res = await ask(port, "/app.css", "dead.test");
    expect(res.status).toBe(502);
    expect(String(res.headers["content-type"])).toContain("text/html");
    expect(res.body).toContain("Application unavailable");
  });

  it("a static vhost never serves it — a missing file is still a plain 404", async () => {
    // The gate in nginx.ts: a route that serves from disk has no upstream, so intercepting
    // 5xx there would be dead config on every static site.
    const res = await ask(port, "/nope", "staticsite.test");
    expect(res.body).not.toContain(EDGE_UPSTREAM_DOWN_SENTINEL);
    // The SPA fallback serves index.html for an unknown path; either way, never our page.
    expect([200, 404]).toContain(res.status);
  });
});
