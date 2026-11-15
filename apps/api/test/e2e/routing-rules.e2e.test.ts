/**
 * Routing and access rules, end to end, against a real OpenResty.
 * Runs with both the on-disk Lua and the embedded copy used by compiled builds.
 * Route-rule payloads go through the real management API and CJSON decoder;
 * no request state, rule matching, shared dictionaries or Lua modules are mocked.
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
 * Config text travels in a Docker archive as quoted heredocs rather than a bind
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

import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DockerRuntime,
  BuildLogger,
  registerResolvedRoutes,
  DockerEdgeExecutor,
  loopbackPortInventoryFor,
  rootChecked,
  EDGE_SHARED_DICTS,
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  compileVercelRouting,
  type CommandExecutor,
  type RootChecked,
  type RouteConfig,
} from "@repo/adapters";
import { normalizeEdgeResponse, type RoutingConfig } from "@repo/core";
import { compileProjectRoutingFields } from "@repo/platform/engine/lib/project-routing-fields";
import { buildDomainFanoutRegistrations } from "@repo/platform/engine/modules/deployments/compose/composite-route";
import type Dockerode from "dockerode";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { freePort } from "../helpers/free-port";
import { EMBEDDED_LUA } from "../../../../packages/adapters/src/infra/lua-embedded";
import { EDGE_CLIENT_MAX_BODY_SIZE } from "../../../../packages/adapters/src/infra/openresty-lua";
import type { HostRuleEntry } from "@repo/platform/engine/modules/route-rules/route-rule.service";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LUA_SRC = join(REPO_ROOT, "packages/adapters/src/infra/lua");
const LUA_DEST = "/usr/local/openresty/site/lualib/openship";
const SITES_DIR = OPENRESTY_DEFAULT_PATHS.sitesDir;
const CONF_PATH = `${OPENRESTY_DEFAULT_PATHS.confDir}/nginx.conf`;
/** Must be under /opt/openship — `assertValidStaticRoot` refuses anything else. */
const WWW = "/opt/openship/www";
/** A multi-page site that ships its own top-level 404.html. */
const WWW_404 = "/opt/openship/www-404";

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
async function staticSite(name: string, routing: RoutingConfig, staticRoot = WWW): Promise<string> {
  return renderVhost({
    domain: `${name}.test`,
    tls: false,
    staticRoot,
    ...compileProjectRoutingFields(routing, (note) => { throw new Error(note); }),
  });
}

interface Answer {
  status: number;
  location?: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** One request with an explicit `Host`, which `fetch` refuses to set. */
function ask(
  port: number,
  path: string,
  host: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        // Probe the current configuration without pooling sockets across reloads.
        agent: false,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          Host: host,
          ...(options.body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(options.body)),
              }),
        },
      },
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
    req.end(options.body);
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

const luaModes = ["source", "embedded"] as const;
describeDockerE2E.each(luaModes)("routing rules, real OpenResty (%s Lua)", (luaMode) => {
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
    client_max_body_size ${EDGE_CLIENT_MAX_BODY_SIZE};
    access_log off;
    lua_package_path "/usr/local/openresty/site/lualib/?.lua;;";
    ${EDGE_SHARED_DICTS.filter(({ name }) => name === "rules" || name === "rl_counters")
      .map(({ name, size }) => `lua_shared_dict ${name} ${size};`)
      .join("\n    ")}

    # Deterministic hot-path instrumentation, isolated to this fixture worker.
    init_worker_by_lua_block {
        local counts = { decodes=0, pathDecodes=0, bodyReads=0, bodyBytes=0, hashes=0 }
        package.loaded.response_test_costs = counts
        local json = require "cjson.safe"
        local decode = json.decode
        json.decode = function(...)
            counts.decodes = counts.decodes + 1
            return decode(...)
        end
        local unescape = ngx.unescape_uri
        ngx.unescape_uri = function(...)
            counts.pathDecodes = counts.pathDecodes + 1
            return unescape(...)
        end
        local dict = ngx.shared.rules
        local get = dict.get
        dict.get = function(self, key, ...)
            local value = get(self, key, ...)
            if string.sub(key, 1, 10) == "responses:" then
                counts.bodyReads = counts.bodyReads + 1
                counts.bodyBytes = counts.bodyBytes + (value and #value or 0)
            end
            return value
        end
        local lib = require "openship.rules_lib"
        local digest = lib.response_revision
        lib.response_revision = function(...)
            counts.hashes = counts.hashes + 1
            return digest(...)
        end
    }

    # Test-only management vhost, on the same loopback-published test port.
    server {
        listen 80;
        server_name management.test;
        location = /response-legacy-worker {
            content_by_lua_block {
                local lib = require "openship.rules_lib"
                if ngx.req.get_method() == "POST" then
                    local previous = {}
                    for _, key in ipairs({ "static_responses", "valid_responses", "response_revision", "response_for" }) do
                        previous[key], lib[key] = lib[key], nil
                    end
                    package.loaded.response_test_previous = previous
                else
                    for key, value in pairs(package.loaded.response_test_previous or {}) do lib[key] = value end
                end
                ngx.say("ok")
            }
        }
        location = /response-costs {
            content_by_lua_block {
                local counts = package.loaded.response_test_costs
                if ngx.req.get_method() == "POST" then
                    for key in pairs(counts) do counts[key] = 0 end
                end
                ngx.say(require("cjson.safe").encode(counts))
            }
        }
        location = /response-memory {
            content_by_lua_block {
                local dict = ngx.shared.rules
                if ngx.req.get_method() == "POST" then
                    local i = 0
                    while dict:safe_set("test-fill:" .. i, string.rep("x", 65536)) do i = i + 1 end
                    ngx.say(i)
                else
                    for _, key in ipairs(dict:get_keys(0)) do
                        if string.sub(key, 1, 10) == "test-fill:" then dict:delete(key) end
                    end
                    ngx.say("cleared")
                end
            }
        }
        location = /policy-cache-check {
            content_by_lua_block {
                ngx.say(ngx.shared.rules:get("rules.test") or "[]")
            }
        }
        location = /country-cache-check {
            content_by_lua_block {
                ngx.say(assert(loadfile("/tmp/visitor-country.lua"))())
            }
        }
        location / { content_by_lua_file ${LUA_DEST}/mgmt_api.lua; }
    }

    server { listen 9901; location / { return 200 "APP uri=$request_uri\\n"; } }
    server { listen 9902; location / { return 200 "THIRDPARTY uri=$request_uri host=$http_host\\n"; } }
    server { listen 9903; location / { return 200 "WEBHOOK uri=$request_uri\\n"; } }
    server { listen 9904; location / { return 200 "BACKEND uri=$request_uri host=$http_host\\n"; } }
    server { listen 9905; location / { return 200 "country=$http_x_visitor_country\\n"; } }

    include ${SITES_DIR}/*.conf;
}
`;

  it("reads stale loopback routes through the Docker socket with no host channel", async () => {
    const routing = new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      containerEdge: true,
      executor: rootChecked(
        new DockerEdgeExecutor({ containerName: started[0]!.id, docker: runtime.docker }),
        "isolated E2E socket edge",
      ),
    });
    const host = {
      exec: vi.fn(async () => {
        throw new Error("host channel unavailable");
      }),
    };
    const inventory = loopbackPortInventoryFor(routing, host as unknown as CommandExecutor);
    const observed = await inventory.listLoopbackUpstreamPortsStrict();
    expect(observed.has(20000)).toBe(true);
    expect(observed.has(9901)).toBe(true);
    expect(observed.has(9904)).toBe(true);
    expect(host.exec).not.toHaveBeenCalled();
  });

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    image = await edgeBaseImage();
    await runtime.pullImage(image);
    // The REAL scripts: the generated vhost references rules_guard/site_logger, and a
    // missing file makes OpenResty error on every request instead of routing it.
    const names = (await readdir(LUA_SRC)).filter((f) => f.endsWith(".lua"));
    lua = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          luaMode === "source"
            ? await readFile(join(LUA_SRC, name), "utf8")
            : Buffer.from(EMBEDDED_LUA[name]!, "base64").toString("utf8"),
        ]),
      ),
    );
    port = await bootAll();
  }, 600_000);

  afterEach(async ({ task }) => {
    if (task.result?.state !== "fail") return;
    for (const c of started) {
      const logs = await c.logs({ stdout: true, stderr: true, tail: 80 });
      process.stderr.write(`OpenResty (${luaMode}, ${c.id}):\n${logs.toString()}\n`);
    }
  });

  afterAll(async () => {
    for (const c of started) await c.remove({ force: true }).catch(() => {});
    await runtime?.dispose().catch(() => {});
  });

  /** Every vhost under test, one per hostname, in ONE container. */
  async function vhosts(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    out["canonical"] = await renderVhost({
      domain: "www.canonical.test", tls: false, targetUrl: "http://127.0.0.1:9901",
      redirectHost: { target: "canonical.test", statusCode: 301 },
    } as RouteConfig);

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
    out["nf"] = await staticSite("nf", { spaFallback: false }, WWW_404);
    out["nf-clean"] = await staticSite("nf-clean", { cleanUrls: true, spaFallback: false }, WWW_404);
    out["nf-strip"] = await staticSite("nf-strip", { trailingSlash: false, spaFallback: false }, WWW_404);
    out["nf-enforce"] = await staticSite("nf-enforce", { trailingSlash: true, spaFallback: false }, WWW_404);

    out["nf-standard"] = await staticSite("nf-standard", { spaFallback: false });
    out["spa-default"] = await staticSite("spa-default", {}, WWW_404);
    out["spa-on"] = await staticSite("spa-on", { spaFallback: true }, WWW_404);
    out["spa-rewrite"] = await staticSite("spa-rewrite", {
      rewrites: [{ source: "/(.*)", destination: "/index.html" }],
    }, WWW_404);
    out["nf-explicit"] = await staticSite("nf-explicit", {
      spaFallback: false, rewrites: [{ source: "/(.*)", destination: "/index.html" }],
    }, WWW_404);
    // Internal 404 handling must not enter the user's HTML proxy or redirect.
    const htmlProxy = compileVercelRouting({ rewrites: [
      { source: "/(.*).html", destination: "/remote/$1" },
    ] }, { backendTargetUrl: "http://127.0.0.1:9902" });
    expect(htmlProxy.skipped).toEqual([]);
    out["nf-proxy"] = await renderVhost({
      domain: "nf-proxy.test", tls: false, staticRoot: WWW_404, spaFallback: false,
      proxyLocations: htmlProxy.proxyLocations,
    });
    out["nf-redirect"] = await staticSite("nf-redirect", { spaFallback: false,
      redirects: [{ source: "/404.html", destination: "/somewhere" }],
    }, WWW_404);

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

    // Start with a complete migrated route, then simulate a retry whose live
    // inspection cannot observe the backend. The old planner replaced this
    // vhost with a root-only route, sending /api requests to the frontend.
    for (const backend of ["http://127.0.0.1:9904", null]) {
      const planned = buildDomainFanoutRegistrations({
        routes: [
          {
            hostname: "retry.test",
            isCustomDomain: true,
            rootServiceId: "web",
            locations: [{ pathPrefix: "/api/", serviceId: "api" }],
          },
        ],
        resolveTargetUrl: (id) => (id === "web" ? "http://127.0.0.1:9901" : backend),
      });
      for (const route of planned)
        out["retry"] = await renderVhost({
          domain: route.hostname,
          tls: false,
          targetUrl: route.targetUrl!,
          proxyLocations: route.proxyLocations,
        });
    }

    // A paths-only import must never acquire an implicit catch-all. Keep the
    // existing complete table when a retry cannot resolve one of its targets.
    for (const backend of ["http://127.0.0.1:9904", null]) {
      const planned = buildDomainFanoutRegistrations({
        routes: [{
          hostname: "pathonly.test",
          isCustomDomain: true,
          locations: [
            { pathPrefix: "/v3/", serviceId: "api" },
            { pathPrefix: "/mcp", exact: true, serviceId: "web" },
          ],
        }, {
          hostname: "exactroot.test",
          isCustomDomain: true,
          locations: [{ pathPrefix: "/", exact: true, serviceId: "web" }],
        }],
        resolveTargetUrl: (id) => id === "web" ? "http://127.0.0.1:9901" : backend,
      });
      for (const route of planned) {
        expect(route.notFound).toBe(true);
        out[route.hostname] = await renderVhost({
          domain: route.hostname,
          tls: false,
          notFound: true,
          proxyLocations: route.proxyLocations,
        });
      }
    }

    for (const host of ["rules.test", "other-rules.test", "rate.test", "other-rate.test"]) {
      out[host] = await renderVhost({
        domain: host,
        tls: false,
        targetUrl: "http://127.0.0.1:9901",
      });
    }
    out["wildcard.wild.test"] = await renderVhost({
      domain: "*.wild.test",
      tls: false,
      targetUrl: "http://127.0.0.1:9901",
    });

    out["country.test"] = await renderVhost({
      domain: "country.test",
      tls: false,
      targetUrl: "http://127.0.0.1:9905",
    });

    // A valid old vhost can survive without a workload or a durable DB claim.
    out["orphan"] = await renderVhost({
      domain: "orphan.test",
      tls: false,
      targetUrl: "http://127.0.0.1:20000",
    });
    return out;
  }

  /** Boot one container holding every vhost; return the published :80 port. */
  async function bootAll(): Promise<number> {
    const confs = await vhosts();
    const script =
      `set -e\n` +
      `mkdir -p ${SITES_DIR} ${LUA_DEST} ${WWW}/docs ${WWW}/dir-no-index ${WWW_404} /var/www/acme/oblien\n` +
      heredoc(CONF_PATH, ENVELOPE) +
      heredoc(
        "/tmp/visitor-country.lua",
        await readFile(join(REPO_ROOT, "apps/api/test/fixtures/visitor-country.lua"), "utf8"),
      ) +
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
      heredoc(`${WWW_404}/index.html`, "MPA-INDEX") +
      heredoc(`${WWW_404}/about.html`, "MPA-ABOUT") +
      heredoc(`${WWW_404}/404.html`, "MPA-NOT-FOUND") +
      Object.entries(confs)
        .map(([name, body]) => heredoc(join(SITES_DIR, `${name}.conf`), body))
        .join("") +
      `openresty -t\n` +
      `exec openresty -g 'daemon off;'\n`;

    const container = await runtime.docker.createContainer({
      Image: image,
      // Embedded Lua can exceed Linux's per-argument limit. Upload a file via
      // the Docker API, which also works when the daemon cannot see host paths.
      Entrypoint: ["sh", "/tmp/openship-routing-bootstrap.sh"],
      Tty: true,
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: await freePort() }] },
        AutoRemove: false,
      },
    });
    started.push(container);
    const bootstrap = await mkdtemp(join(tmpdir(), "openship-routing-bootstrap-"));
    try {
      await writeFile(join(bootstrap, "openship-routing-bootstrap.sh"), script);
      const { stdout } = await promisify(execFile)("tar", ["--format=ustar", "--no-xattrs", "-cf", "-", "-C", bootstrap, "openship-routing-bootstrap.sh"],
        { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
      await container.putArchive(stdout, { path: "/tmp" });
    } finally {
      await rm(bootstrap, { recursive: true, force: true });
    }
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

  it("publishes independent domains and changes both live upstreams on redeployment", async () => {
    const executor = new DockerEdgeExecutor({
      containerName: started[0]!.id, docker: runtime.docker, fileMode: "container",
    });
    const routing = new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS, containerEdge: true, pinPaths: true,
      executor: rootChecked(executor, "isolated E2E route updates"),
    });
    const routes = ["parallel-a.test", "parallel-b.test"].map(hostname => ({ hostname, tls: false, targetPort: 9901 }));
    const logger = new BuildLogger(() => {});
    const initialFiles = new Map<string, string>();
    for (const [upstream, body] of [[9901, "APP"], [9904, "BACKEND"]] as const) {
      const warnings = await registerResolvedRoutes(logger, routing, undefined, routes, { targetUrl: `http://127.0.0.1:${upstream}` });
      expect(warnings).toEqual([]);
      for (const route of routes) {
        await vi.waitFor(async () => {
          const response = await ask(port, "/deployment", route.hostname);
          expect(response.status).toBe(200);
          expect(response.body).toContain(`${body} uri=/deployment`);
        }, { timeout: 10_000 });
      }
      if (upstream === 9901) {
        for (const suffix of ["conf", "route.json"]) {
          const path = `${SITES_DIR}/parallel-a-test.${suffix}`;
          initialFiles.set(path, await executor.readFile(path));
        }
      }
    }
    // Another deploy can publish the desired files and fail before reloading.
    // Matching disk on retry must still activate them in the running edge.
    for (const [path, content] of initialFiles) {
      await executor.writeFile(path, content, { mode: 0o600 });
    }
    expect((await ask(port, "/deployment", "parallel-a.test")).body).toContain("BACKEND uri=/deployment");
    expect(await registerResolvedRoutes(logger, routing, undefined, [routes[0]!], {
      targetUrl: "http://127.0.0.1:9901",
    })).toEqual([]);
    await vi.waitFor(async () => {
      expect((await ask(port, "/deployment", "parallel-a.test")).body).toContain("APP uri=/deployment");
    }, { timeout: 10_000 });

    const warnings = await registerResolvedRoutes(logger, routing, undefined,
      [{ hostname: "invalid.test", tls: false }, ...routes], { targetUrl: "http://127.0.0.1:9901" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("invalid.test");
    for (const route of routes) {
      await vi.waitFor(async () => expect((await ask(port, "/deployment", route.hostname)).body).toContain("APP uri=/deployment"), { timeout: 10_000 });
    }
  });

  it("preserves path-only upstreams after an incomplete retry and returns 404 elsewhere", async () => {
    const api = await ask(port, "/v3/items?limit=2", "pathonly.test");
    expect(api.status).toBe(200);
    expect(api.body).toContain("BACKEND uri=/v3/items?limit=2");
    const exact = await ask(port, "/mcp?request=1", "pathonly.test");
    expect(exact.status).toBe(200);
    expect(exact.body).toContain("APP uri=/mcp?request=1");
    for (const path of ["/", "/private", "/v3-other", "/mcp/child"])
      expect((await ask(port, path, "pathonly.test")).status, path).toBe(404);
  });

  it("keeps an exact root separate from a catch-all", async () => {
    expect((await ask(port, "/?request=1", "exactroot.test")).status).toBe(200);
    expect((await ask(port, "/anything", "exactroot.test")).status).toBe(404);
  });

  it.each([
    "/", "/docs/a%2Fb?x=1&x=2&encoded=a%2Bb", "/hello/%E2%9C%93?q=%26&empty=&flag",
  ])("preserves the original URL through a canonical hostname redirect: %s", async (path) => {
    const answer = await ask(port, path, "www.canonical.test");
    expect(answer.status).toBe(301);
    expect(answer.location).toBe(`https://canonical.test${path}`);
  });

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

  it("serves a custom 404 only when SPA fallback is disabled", async () => {
    // The bug: every unknown path answered 200 with the home page, so the site's own
    // 404.html never showed and a missing JSON file was "found" as HTML (#1624).
    for (const path of ["/missing", "/a/b/c", "/x.json", "/.well-known/ai-catalog.json"]) {
      const answer = await ask(port, path, "nf.test");
      expect({ path, status: answer.status, body: answer.body.trim() }).toEqual({
        path,
        status: 404,
        body: "MPA-NOT-FOUND",
      });
    }
    expect((await ask(port, "/", "nf.test")).body.trim()).toBe("MPA-INDEX");
    expect((await ask(port, "/about", "nf-clean.test")).body.trim()).toBe("MPA-ABOUT");
    expect((await ask(port, "/missing", "nf-clean.test")).status).toBe(404);
    // URL shaping still runs first, then the missing path gets the 404 page.
    for (const [host, path, hop] of [
      ["nf-strip.test", "/missing/", "http://nf-strip.test/missing"],
      ["nf-enforce.test", "/missing", "http://nf-enforce.test/missing/"],
    ] as const) {
      const { hops, final } = await follow(port, path, host);
      expect({ hops, status: final.status, body: final.body.trim() }).toEqual({
        hops: [hop],
        status: 404,
        body: "MPA-NOT-FOUND",
      });
    }
    // A root without 404.html keeps the SPA fallback.
    const spa = await ask(port, "/missing", "clean.test");
    expect(spa.status).toBe(200);
    expect(spa.body.trim()).toBe("ROOT-INDEX");
  });

  it.each(["spa-default.test", "spa-on.test", "spa-rewrite.test"])("preserves deep links even with a 404.html: %s", async (host) => {
    for (const path of ["/dashboard/settings", "/missing.js", "/missing?x=1"]) {
      const answer = await ask(port, path, host);
      expect(answer.status).toBe(200);
      expect(answer.body.trim()).toBe("MPA-INDEX");
    }
  });

  it("returns 404 without a custom page and honors the explicit switch over a legacy SPA rewrite", async () => {
    const standard = await ask(port, "/missing", "nf-standard.test");
    expect(standard.status).toBe(404);
    expect(standard.body).not.toContain("ROOT-INDEX");
    const explicit = await ask(port, "/missing", "nf-explicit.test");
    expect(explicit.status).toBe(404);
    expect(explicit.body.trim()).toBe("MPA-NOT-FOUND");
    const head = await ask(port, "/missing", "nf.test", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(head.body).toBe("");
  });

  it.each(["nf-proxy.test", "nf-redirect.test"])("isolates the custom 404 from user rules: %s", async (host) => {
    const missing = await ask(port, "/missing", host);
    expect(missing.status).toBe(404);
    expect(missing.body.trim()).toBe("MPA-NOT-FOUND");
    expect(missing.headers["content-type"]).toContain("text/html");
    const direct = await ask(port, "/404.html", host);
    if (host === "nf-proxy.test") expect(direct.body).toContain("THIRDPARTY");
    else expect(direct.location).toBe("http://nf-redirect.test/somewhere");
  });

  it.each([
    ["enforce.test", "/ui", "/ui/"],
    ["strip.test", "/ui/", "/ui"],
    ["clean.test", "/about.html", "/about"],
  ])(
    "preserves raw query parameters through URL normalization on %s (#845)",
    async (host, path, target) => {
      const query = "?token=abc%2B123%2F%3D&next=%2Fui%3Ftab%3D1&tag=a&tag=b";
      const answer = await ask(port, path + query, host);
      expect(answer.status).toBe(308);
      expect(answer.location).toBe(`http://${host}${target}${query}`);
      const result = await follow(port, path + query, host);
      expect(result.hops).toEqual([answer.location]);
      expect(result.final.status).toBe(200);
    },
  );

  // ── The silent one ───────────────────────────────────────────────────────────

  it("gives every path-scoped header rule its own value", async () => {
    // Two rules on one source, and two paths that squashed to the same variable name,
    // used to share one `map` — last declaration wins, so one header shipped the other's
    // value and the other vanished. `openresty -t` accepts the duplicate, which is why
    // only a real response could catch this.
    const api = await ask(port, "/api/thing", "hdrs.test");
    expect(api.headers["x-one"]).toBe("1");
    expect(api.headers["x-two"]).toBe("2");

    const dash = await ask(port, "/a-b/", "hdrs.test");
    expect(dash.headers["x-dash"]).toBe("dash");
    expect(dash.headers["x-slash"]).toBeUndefined();

    const slash = await ask(port, "/a/b/", "hdrs.test");
    expect(slash.headers["x-slash"]).toBe("slash");
    expect(slash.headers["x-dash"]).toBeUndefined();

    // Literal Vercel sources match exactly, including when a query is present.
    // Descendants require an explicit wildcard (as used by the /api rules).
    expect((await ask(port, "/a-b/?q=1", "hdrs.test")).headers["x-dash"]).toBe("dash");
    expect((await ask(port, "/a-b/x", "hdrs.test")).headers["x-dash"]).toBeUndefined();
    expect((await ask(port, "/a/b/x", "hdrs.test")).headers["x-slash"]).toBeUndefined();

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

  it("keeps serving the complete route when a retry cannot observe one of its upstreams", async () => {
    expect((await ask(port, "/", "retry.test")).body).toContain("APP uri=/");
    const api = await ask(port, "/api/health", "retry.test");
    expect(api.status).toBe(200);
    expect(api.body).toContain("BACKEND uri=/api/health");
    expect(api.body).not.toContain("APP uri=");
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

  // ── Per-host access rules (the same path used by whole-project rules) ──────────

  async function pushRules(
    host: string,
    rules: Array<
      Omit<HostRuleEntry, "pathPrefix"> & {
        pathPrefix?: string | null;
      }
    >,
    targetPort = port,
  ): Promise<void> {
    const response = await ask(targetPort, "/rules", "management.test", {
      method: "POST",
      body: JSON.stringify({ host, rules }),
    });
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, host, count: rules.length });
  }

  it("serves exact literal responses with headers, query strings, Unicode and HEAD", async () => {
    const body = '{"message":"مرحبا","literal":"$host; return 500;"}';
    await pushRules("rules.test", [
      {
        pathPrefix: "/virtual",
        spec: {
          response: normalizeEdgeResponse({
            status: 201,
            contentType: "application/json",
            body,
            headers: { "X-Example": "literal-$host" },
          }),
        },
      },
    ]);
    const result = await ask(port, "/virtual?source=test", "rules.test");
    expect(result).toMatchObject({ status: 201, body });
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["x-example"]).toBe("literal-$host");
    expect(result.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    const head = await ask(port, "/virtual", "rules.test", { method: "HEAD" });
    expect(head).toMatchObject({ status: 201, body: "" });
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    for (const path of ["/virtual/child", "/virtual-other"]) {
      expect((await ask(port, path, "rules.test")).body).not.toBe(body);
    }
    expect((await ask(port, "/virtual", "other-rules.test")).body).not.toBe(body);
    expect((await ask(port, "/virtual", "rules.test", { method: "POST" })).status).not.toBe(201);
  });

  it("keeps responses out of the legacy policy cache during edge upgrades", async () => {
    const capability = await ask(port, "/rules/capabilities", "management.test", {
      method: "POST",
      body: "{}",
    });
    expect(JSON.parse(capability.body)).toMatchObject({ ok: true, staticResponses: true });
    const policy = { pathPrefix: null, spec: { access: { methods: ["GET"] } } };
    await pushRules("rules.test", [
      policy,
      { pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ body: "ready" }) } },
    ]);
    const legacy = await ask(port, "/policy-cache-check", "management.test");
    expect(JSON.parse(legacy.body)).toEqual([policy]);
    const stored = await ask(port, "/rules?host=rules.test", "management.test");
    expect(JSON.parse(stored.body).rules).toHaveLength(2);
    await ask(port, "/rules?host=rules.test", "management.test", { method: "DELETE" });
    expect((await ask(port, "/virtual", "rules.test")).body).not.toBe("ready");
  });

  it("still publishes policies while a worker has the previous rules library loaded", async () => {
    // Earlier route-update tests gracefully reload the shared edge. Their old
    // and new workers can briefly overlap, so a worker-local library mutation
    // must use a fresh edge whose single worker is stable across these requests.
    const legacyPort = await bootAll();
    await pushRules("rules.test", [
      { pathPrefix: null, spec: { access: { methods: ["GET"] } } },
      {
        pathPrefix: "/virtual",
        spec: { response: normalizeEdgeResponse({ body: "new worker response" }) },
      },
    ], legacyPort);
    await ask(legacyPort, "/response-legacy-worker", "management.test", { method: "POST" });
    try {
      // A new worker may already have published a response into shared memory.
      // This worker must still enforce its policies and serve ordinary traffic.
      const ordinary = await ask(legacyPort, "/virtual", "rules.test");
      expect(ordinary.status).toBe(200);
      expect(ordinary.body).not.toBe("new worker response");
      expect((await ask(legacyPort, "/virtual", "rules.test", { method: "POST" })).status).toBe(403);
      await pushRules("rules.test", [{ pathPrefix: null, spec: { access: { methods: ["GET"] } } }], legacyPort);
      const capability = await ask(legacyPort, "/rules/capabilities", "management.test");
      expect(JSON.parse(capability.body).staticResponses).toBe(false);
      const response = await ask(legacyPort, "/rules", "management.test", {
        method: "POST",
        body: JSON.stringify({
          host: "rules.test",
          rules: [
            {
              pathPrefix: "/virtual",
              spec: { response: normalizeEdgeResponse({ body: "not yet" }) },
            },
          ],
        }),
      });
      expect(response.status).toBe(409);
      expect((await ask(legacyPort, "/virtual", "rules.test", { method: "POST" })).status).toBe(403);
    } finally {
      await ask(legacyPort, "/response-legacy-worker", "management.test", { method: "DELETE" });
    }
  });

  it("retains domain access, bans and rate limits in front of a static response", async () => {
    const response = {
      pathPrefix: "/virtual",
      spec: { response: normalizeEdgeResponse({ body: "answer", methods: [] }) },
    };
    for (const policy of [
      { access: { methods: ["POST"] } },
      { ban: { userAgents: ["blocked-client"] } },
      { hotlink: { allowReferers: ["allowed.test"], allowEmpty: false } },
    ]) {
      await pushRules("rules.test", [response, { pathPrefix: null, spec: policy }]);
      expect(
        (await ask(port, "/virtual", "rules.test", { headers: { "User-Agent": "blocked-client" } }))
          .status,
      ).toBe(403);
    }
    await pushRules("rules.test", [
      response,
      { pathPrefix: "/virtual", spec: { rateLimit: { rps: 1, burst: 0 } } },
    ]);
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () => ask(port, "/virtual", "rules.test").then((r) => r.status)),
    );
    expect(statuses).toContain(429);
  });

  it("matches prefixes at a path boundary and gives exact responses precedence", async () => {
    const rules = [
      {
        pathPrefix: "/virtual",
        spec: { response: normalizeEdgeResponse({ match: "prefix", body: "prefix" }) },
      },
      { pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ body: "exact" }) } },
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      await pushRules("rules.test", ordered);
      expect((await ask(port, "/virtual", "rules.test")).body).toBe("exact");
      expect((await ask(port, "/virtual/child", "rules.test")).body).toBe("prefix");
      expect((await ask(port, "/virtual-other", "rules.test")).body).not.toBe("prefix");
    }
    await pushRules("rules.test", [
      {
        pathPrefix: "/index.html",
        spec: { response: normalizeEdgeResponse({ body: "only-index" }) },
      },
    ]);
    expect((await ask(port, "/unmatched-spa-path", "rules.test")).body).not.toBe("only-index");
  });

  it("keeps custom error content and empty responses exact, including bodyless statuses", async () => {
    for (const [status, body] of [
      [404, "Custom missing page"],
      [503, ""],
      [204, ""],
      [205, ""],
      [304, ""],
    ] as const) {
      await pushRules("rules.test", [
        { pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ status, body }) } },
      ]);
      const answer = await ask(port, "/virtual", "rules.test");
      expect(answer).toMatchObject({ status, body });
      if (status === 204 || status === 304)
        expect(answer.headers["content-length"]).toBeUndefined();
    }
  });

  it("applies large bodies, updates and removal without a reload", async () => {
    const body = "ع".repeat(32000);
    await pushRules("rules.test", [
      { pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ body }) } },
    ]);
    expect((await ask(port, "/virtual", "rules.test")).body).toBe(body);
    await pushRules("rules.test", [
      { pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ body: "updated" }) } },
    ]);
    expect((await ask(port, "/virtual", "rules.test")).body).toBe("updated");
    await pushRules("rules.test", []);
    expect((await ask(port, "/virtual", "rules.test")).body).not.toBe("updated");
  });

  it("rejects unsafe or malformed responses before changing active rules", async () => {
    const original = normalizeEdgeResponse({ body: "original response" });
    await pushRules("rules.test", [
      { pathPrefix: null, spec: { access: { methods: ["GET"] } } },
      { pathPrefix: "/virtual", spec: { response: original } },
    ]);
    const invalid = [
      { headers: { "X-Test": "ok\r\nInjected: yes" } },
      { headers: { "X-Test": "nul\0value" } },
      { headers: { "Bad Header": "value" } },
      { headers: { "X-Test": "one", "x-test": "two" } },
      ...[
        "Content-Length",
        "Transfer-Encoding",
        "Content-Encoding",
        "Connection",
        "X-Accel-Redirect",
      ].map((name) => ({ headers: { [name]: "unsafe" } })),
      { headers: { "X-Test": "a".repeat(2049) } },
      { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, "value"])) },
      {
        headers: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [`X-${i}`, "a".repeat(2048)]),
        ),
      },
      { body: "ع".repeat(32769) },
      { status: 101 },
      { status: 204 },
      { status: 200.5 },
      { contentType: "text/plain\r\nInjected: yes" },
      { contentType: "bad-type" },
      { methods: "GET" },
      { methods: ["TRACE"] },
      { methods: { GET: true } },
      { match: "regex" },
    ];
    for (const override of invalid) {
      const rejected = await ask(port, "/rules", "management.test", {
        method: "POST",
        body: JSON.stringify({
          host: "rules.test",
          rules: [{ pathPrefix: "/virtual", spec: { response: { ...original, ...override } } }],
        }),
      });
      expect(rejected.status, JSON.stringify(override).slice(0, 100)).toBe(400);
      const answer = await ask(port, "/virtual", "rules.test");
      expect(answer.body).toBe(original.body);
      expect(answer.headers["injected"]).toBeUndefined();
      expect((await ask(port, "/virtual", "rules.test", { method: "POST" })).status).toBe(403);
    }
    for (const pathPrefix of [
      "/_openship/hooks/probe",
      "/.openship/auth",
      "/.well-known/acme-challenge/probe",
      "/../virtual",
      "/bad//path",
      "/bad%2Fpath",
      "/" + "x".repeat(512),
    ]) {
      const rejected = await ask(port, "/rules", "management.test", {
        method: "POST",
        body: JSON.stringify({
          host: "rules.test",
          rules: [{ pathPrefix, spec: { response: original } }],
        }),
      });
      expect(rejected.status, pathPrefix).toBe(400);
    }
  });

  it("bounds route counts and preserves access policies when response storage is full", async () => {
    const responses = Array.from({ length: 64 }, (_, i) => ({
      pathPrefix: `/bounded/${i}`,
      spec: { response: normalizeEdgeResponse({ body: `response-${i}` }) },
    }));
    await pushRules("rules.test", responses);
    expect((await ask(port, "/bounded/63", "rules.test")).body).toBe("response-63");
    for (const extra of [responses[0], { ...responses[0], pathPrefix: "/overflow" }]) {
      const rejected = await ask(port, "/rules", "management.test", {
        method: "POST",
        body: JSON.stringify({ host: "rules.test", rules: [...responses, extra] }),
      });
      expect(rejected.status).toBe(400);
      expect((await ask(port, "/bounded/63", "rules.test")).body).toBe("response-63");
    }
    await pushRules("rules.test", [{ pathPrefix: null, spec: { access: { methods: ["GET"] } } }]);
    try {
      expect(
        (await ask(port, "/response-memory", "management.test", { method: "POST" })).status,
      ).toBe(200);
      const failed = await ask(port, "/rules", "management.test", {
        method: "POST",
        body: JSON.stringify({
          host: "other-rules.test",
          rules: responses.map((entry) => ({
            ...entry,
            spec: { response: normalizeEdgeResponse({ body: "x".repeat(65536) }) },
          })),
        }),
      });
      expect(failed.status, failed.body).toBe(503);
      expect((await ask(port, "/virtual", "rules.test", { method: "POST" })).status).toBe(403);
    } finally {
      await ask(port, "/response-memory", "management.test", { method: "DELETE" });
    }
  });

  it("keeps unconfigured traffic cheap and reuses compiled responses without copying bodies", async () => {
    const reset = () => ask(port, "/response-costs", "management.test", { method: "POST" });
    const costs = async () =>
      JSON.parse((await ask(port, "/response-costs", "management.test")).body);
    for (const policies of [[], [{ pathPrefix: null, spec: { access: { methods: ["GET"] } } }]]) {
      await pushRules("rules.test", policies);
      await ask(port, "/", "rules.test"); // warm existing policy/GeoIP caches
      await reset();
      for (let i = 0; i < 16; i++) await ask(port, "/", "rules.test");
      expect(await costs()).toEqual({
        decodes: 0,
        pathDecodes: 0,
        bodyReads: 0,
        bodyBytes: 0,
        hashes: 0,
      });
    }
    const entries = (body: string) => [
      { pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ body }) } },
    ];
    const body = "x".repeat(65536);
    await pushRules("rules.test", entries(body));
    await reset();
    expect((await ask(port, "/virtual", "rules.test")).body).toBe(body);
    expect(await costs()).toMatchObject({ decodes: 1, pathDecodes: 1, bodyReads: 1, hashes: 1 });
    await reset();
    for (let i = 0; i < 16; i++)
      expect((await ask(port, `/virtual?request=${i}`, "rules.test")).body).toBe(body);
    expect(await costs()).toEqual({
      decodes: 0,
      pathDecodes: 16,
      bodyReads: 0,
      bodyBytes: 0,
      hashes: 0,
    });
    await pushRules("rules.test", entries("refreshed"));
    await reset();
    expect((await ask(port, "/virtual", "rules.test")).body).toBe("refreshed");
    expect(await costs()).toMatchObject({ decodes: 1, bodyReads: 1, hashes: 1 });
    await pushRules("rules.test", []);
    await reset();
    expect((await ask(port, "/virtual", "rules.test")).body).not.toBe("refreshed");
    expect(await costs()).toEqual({
      decodes: 0,
      pathDecodes: 0,
      bodyReads: 0,
      bodyBytes: 0,
      hashes: 0,
    });
  });

  it("supports an OPTIONS response and leaves platform paths alone under a catch-all", async () => {
    await pushRules("rules.test", [
      {
        pathPrefix: "/virtual",
        spec: {
          response: normalizeEdgeResponse({
            status: 204,
            methods: ["OPTIONS"],
            headers: { "Access-Control-Allow-Origin": "https://client.test" },
          }),
        },
      },
    ]);
    const options = await ask(port, "/virtual", "rules.test", { method: "OPTIONS" });
    expect(options).toMatchObject({ status: 204, body: "" });
    expect(options.headers["access-control-allow-origin"]).toBe("https://client.test");
    await pushRules("rules.test", [
      {
        pathPrefix: null,
        spec: { response: normalizeEdgeResponse({ match: "prefix", body: "catch-all" }) },
      },
    ]);
    expect((await ask(port, "/ordinary", "rules.test")).body).toBe("catch-all");
    for (const path of [
      "/_openship/hooks/probe",
      "/.openship/auth",
      "/.well-known/acme-challenge/probe",
      "/ignored/../.openship/auth",
      "//.openship/auth",
    ]) {
      expect((await ask(port, path, "rules.test")).body).not.toBe("catch-all");
    }
  });

  it.each([
    ["JSON null", null],
    ["omitted", undefined],
    ["empty", ""],
    ["root", "/"],
  ] as const)(
    "enforces a whole-host rule with a %s prefix without HTTP 500",
    async (_, pathPrefix) => {
      await pushRules("rules.test", [{ pathPrefix, spec: { access: { methods: ["GET"] } } }]);
      for (const path of ["/", "/deep/path"]) {
        expect((await ask(port, path, "rules.test")).status).toBe(200);
        expect((await ask(port, path, "rules.test", { method: "POST" })).status).toBe(403);
      }
      // The payload stored by the management API preserves JSON null; the parser
      // must fix its representation without dropping or disabling the rule.
      const stored = await ask(port, "/rules?host=rules.test", "management.test");
      expect(JSON.parse(stored.body).rules[0].pathPrefix).toBe(pathPrefix);
    },
  );

  it("keeps longest-prefix precedence and literal matching with a null fallback", async () => {
    const rules: HostRuleEntry[] = [
      { pathPrefix: null, spec: { access: { methods: ["GET"] } } },
      { pathPrefix: "/api", spec: { access: { methods: ["POST"] }, block: { status: 401 } } },
      {
        pathPrefix: "/api/admin",
        spec: { access: { methods: ["DELETE"] }, block: { status: 451 } },
      },
      { pathPrefix: "/literal.+", spec: { access: { methods: ["POST"] } } },
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      await pushRules("rules.test", ordered);
      expect((await ask(port, "/api/items", "rules.test")).status).toBe(401);
      expect((await ask(port, "/api/items", "rules.test", { method: "POST" })).status).toBe(200);
      expect((await ask(port, "/api/admin/items", "rules.test", { method: "POST" })).status).toBe(
        451,
      );
      expect((await ask(port, "/api/admin/items", "rules.test", { method: "DELETE" })).status).toBe(
        200,
      );
      expect((await ask(port, "/other", "rules.test", { method: "POST" })).status).toBe(403);
      expect((await ask(port, "/literalXYZ", "rules.test", { method: "POST" })).status).toBe(403);
      expect((await ask(port, "/literal.+", "rules.test", { method: "POST" })).status).toBe(200);
    }
  });

  it("enforces a wildcard domain's rules on every subdomain it serves", async () => {
    // Rules are stored under the domain row's hostname, which for a wildcard
    // domain is the pattern itself, while $host is the concrete name requested.
    await pushRules("*.wild.test", [{ pathPrefix: null, spec: { access: { methods: ["GET"] } } }]);
    for (const host of ["app.wild.test", "a.b.wild.test"]) {
      expect((await ask(port, "/", host)).status).toBe(200);
      expect((await ask(port, "/", host, { method: "POST" })).status).toBe(403);
    }
    // An exact ruleset inside the wildcard wins without changing sibling hosts.
    await pushRules("app.wild.test", [{ pathPrefix: null, spec: { access: { methods: ["POST"] } } }]);
    expect((await ask(port, "/", "app.wild.test", { method: "POST" })).status).toBe(200);
    expect((await ask(port, "/", "app.wild.test")).status).toBe(403);
    expect((await ask(port, "/", "a.b.wild.test")).status).toBe(200);
    expect((await ask(port, "/", "a.b.wild.test", { method: "POST" })).status).toBe(403);
    // Clearing the exact override restores wildcard enforcement.
    await pushRules("app.wild.test", []);
    expect((await ask(port, "/", "app.wild.test")).status).toBe(200);
    expect((await ask(port, "/", "app.wild.test", { method: "POST" })).status).toBe(403);
  });

  it("enforces null-prefix IP restrictions, user-agent bans and hotlink protection", async () => {
    await pushRules("rules.test", [
      {
        pathPrefix: null,
        spec: { access: { allowCidrs: ["203.0.113.9"] } },
      },
    ]);
    // Forwarded headers from an untrusted peer cannot satisfy the allow-list.
    expect(
      (
        await ask(port, "/", "rules.test", {
          headers: { "X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.9" },
        })
      ).status,
    ).toBe(403);
    expect((await ask(port, "/", "other-rules.test")).status).toBe(200);

    await pushRules("rules.test", [
      { pathPrefix: null, spec: { ban: { userAgents: ["bad-bot"] } } },
    ]);
    expect(
      (await ask(port, "/", "rules.test", { headers: { "User-Agent": "Good-Bot" } })).status,
    ).toBe(200);
    expect(
      (await ask(port, "/", "rules.test", { headers: { "User-Agent": "BAD-BOT/1.0" } })).status,
    ).toBe(403);

    await pushRules("rules.test", [
      {
        pathPrefix: null,
        spec: { hotlink: { allowReferers: ["allowed.test"], allowEmpty: false } },
      },
    ]);
    expect((await ask(port, "/asset", "rules.test")).status).toBe(403);
    expect(
      (
        await ask(port, "/asset", "rules.test", {
          headers: { Referer: "https://allowed.test/page" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await ask(port, "/asset", "rules.test", {
          headers: { Referer: "https://allowed.test.attacker.test/page" },
        })
      ).status,
    ).toBe(403);
  });

  it("updates and deletes a cached ruleset without changing another host", async () => {
    const getOnly: HostRuleEntry[] = [{ pathPrefix: null, spec: { access: { methods: ["GET"] } } }];
    await pushRules("rules.test", getOnly);
    await pushRules("other-rules.test", getOnly);
    expect((await ask(port, "/", "rules.test", { method: "POST" })).status).toBe(403);
    expect((await ask(port, "/", "other-rules.test", { method: "POST" })).status).toBe(403);
    await pushRules("rules.test", [{ pathPrefix: null, spec: { access: { methods: ["POST"] } } }]);
    expect((await ask(port, "/", "rules.test", { method: "POST" })).status).toBe(200);
    expect((await ask(port, "/", "rules.test")).status).toBe(403);
    const deleted = await ask(port, "/rules?host=rules.test", "management.test", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect((await ask(port, "/", "rules.test")).status).toBe(200);
    expect((await ask(port, "/", "other-rules.test", { method: "POST" })).status).toBe(403);
  });

  it("rate-limits a null-prefix rule across paths with separate host and prefix buckets", async () => {
    const spec: HostRuleEntry["spec"] = { rateLimit: { rps: 1, burst: 1 } };
    await pushRules("rate.test", [
      { pathPrefix: null, spec },
      { pathPrefix: "/api", spec },
    ]);
    await pushRules("other-rate.test", [{ pathPrefix: null, spec }]);
    expect((await ask(port, "/first", "rate.test")).status).toBe(200);
    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, i) => ask(port, `/path-${i}`, "rate.test")),
    );
    // A burst straddling a second boundary can use two windows. Require actual
    // limiting without asserting a timing-dependent exact response count.
    expect(responses.every(({ status }) => status === 200 || status === 429)).toBe(true);
    const limited = responses.filter(({ status }) => status === 429);
    expect(limited.length).toBeGreaterThan(0);
    for (const response of limited) expect(response.headers["retry-after"]).toBe("1");
    expect((await ask(port, "/first", "other-rate.test")).status).toBe(200);
    expect((await ask(port, "/api/first", "rate.test")).status).toBe(200);
    await sleep(1_100);
    expect((await ask(port, "/next-window", "rate.test")).status).toBe(200);
  });

  it("shares country results across access/log phases and caches repeated and unknown IPs", async () => {
    const response = await ask(port, "/country-cache-check", "management.test");
    expect(response.status, response.body).toBe(200);
    expect(response.body.trim()).toBe("country cache and failure checks passed");
  });

  it("removes a forged country before proxying a no-rules host when GeoIP is unavailable", async () => {
    // This base-image fixture has no GeoIP database; the app must still answer,
    // with the client-supplied country removed rather than passed through.
    const response = await ask(port, "/", "country.test", {
      headers: { "x-visitor-country": "RU" },
    });
    expect(response.status, response.body).toBe(200);
    expect(response.body.trim()).toBe("country=");
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
