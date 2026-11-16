import { afterAll, beforeAll, expect, it } from "vitest";
import Docker from "dockerode";
import { request as httpsRequest, Agent } from "node:https";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { compileEdgePages, normalizeEdgeResponse, type EdgePages } from "@repo/core";
import {
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  createRouteProtection,
  revokeRouteSessions,
  type RootChecked,
  type RouteProtection,
} from "@repo/adapters";
import { bakedEdgeNginxConf } from "../../../../packages/adapters/src/infra/edge-baked-conf";
import { edgeDefaultCertPaths } from "../../../../packages/adapters/src/infra/openresty-lua";
import { EMBEDDED_LUA } from "../../../../packages/adapters/src/infra/lua-embedded";
import { makeTestCert } from "../../../../packages/adapters/src/system/proxy/test-certs";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";

// Isolated edge container with loopback-only test ports. The host-network opt-in
// is for a separate development VM with SSH forwarding, never a production daemon.
const tlsPort = Number(process.env.ROUTE_PROTECTION_TEST_TLS_PORT ?? 39443);
const httpPort = Number(process.env.ROUTE_PROTECTION_TEST_HTTP_PORT ?? 39480);
const sq = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const password = "only-test-password-1372";
let container: Docker.Container | undefined;
let nginx: NginxProvider;
let protection: RouteProtection;
let cookie: string;
let docker: Docker;
const paths = OPENRESTY_DEFAULT_PATHS;
const proxyLocations = [
  { pathPrefix: "/api/", targetUrl: "http://127.0.0.1:39482", external: true },
  { pathPrefix: "/offline/", targetUrl: "http://127.0.0.1:39483", external: true },
];

async function exec(command: string, options?: { user?: string; timeout?: number }): Promise<string> {
  const process = await container!.exec({
    Cmd: ["sh", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    ...(options?.user ? { User: options.user } : {}),
  });
  const stream = await process.start({ hijack: true, stdin: false });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  docker.modem.demuxStream(stream, output, output);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const text = Buffer.concat(chunks).toString();
  if ((await process.inspect()).ExitCode !== 0) throw new Error(text);
  return text;
}
async function write(path: string, contents: string, mode = 0o644) {
  // Match the container executor's bounded writes: HTML can exceed the kernel's
  // per-argument limit once encoded in a vhost. Never expand payload as shell code.
  await exec(
    `mkdir -p ${sq(path.substring(0, path.lastIndexOf("/")))} && (umask 077; : > ${sq(path)}) && chmod ${mode.toString(8)} ${sq(path)}`,
  );
  const encoded = Buffer.from(contents).toString("base64");
  for (let offset = 0; offset < encoded.length; offset += 32768)
    await exec(`printf %s ${sq(encoded.slice(offset, offset + 32768))} | base64 -d >> ${sq(path)}`);
}
type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
function ask(
  path = "/",
  options: {
    host?: string;
    cookie?: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    http?: boolean;
    agent?: Agent;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const host = options.host ?? "private.test";
    const req = (options.http ? httpRequest : httpsRequest)(
      {
        agent: options.agent ?? false,
        host: "127.0.0.1",
        port: options.http ? httpPort : tlsPort,
        servername: host,
        rejectUnauthorized: false,
        method: options.method ?? "GET",
        path,
        headers: {
          Host: host,
          Accept: "text/html",
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...options.headers,
          ...(options.body ? { "Content-Length": Buffer.byteLength(options.body) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("edge request timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
}
// nginx's reload signal is asynchronous; each test starts after the prior
// generation has stopped accepting connections, not in the middle of a reload.
async function settleReload() {
  await new Promise((resolve) => setTimeout(resolve, 350));
}
async function login(value = password, returnPath = "/") {
  const page = await ask(returnPath);
  expect(page.status).toBe(401);
  // no-referrer makes real browser form POSTs send Origin: null, which
  // the strict origin check correctly rejects before password verification.
  expect(page.headers["referrer-policy"]).toBe("same-origin");
  const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();
  return ask("/_openship/access", {
    method: "POST",
    body: new URLSearchParams({ password: value, return: returnPath, csrf: csrf! }).toString(),
    headers: {
      Origin: "https://private.test",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
}

describeDockerE2E("password-protected routes through the real edge", () => {
  beforeAll(async () => {
    await requireDocker();
    docker = new Docker({ socketPath: dockerSocketPath });
    const dockerfile = await readFile(
      new URL("../../../../apps/edge/Dockerfile", import.meta.url),
      "utf8",
    );
    const image = dockerfile.match(/^FROM\s+(\S+)/m)![1];
    try {
      await docker.getImage(image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) =>
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) =>
          err
            ? reject(err)
            : docker.modem.followProgress(stream, (error: Error | null) =>
                error ? reject(error) : resolve(),
              ),
        ),
      );
    }
    container = await docker.createContainer({
      Image: image,
      Cmd: ["sh", "-c", "sleep 1800"],
      ExposedPorts: { [`${tlsPort}/tcp`]: {}, [`${httpPort}/tcp`]: {} },
      HostConfig:
        process.env.ROUTE_PROTECTION_TEST_HOST_NETWORK === "1"
          ? { NetworkMode: "host" }
          : {
              PortBindings: {
                [`${tlsPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(tlsPort) }],
                [`${httpPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(httpPort) }],
              },
            },
    });
    await container.start();
    const cert = makeTestCert(["private.test", "public.test", "other.test"]);
    const defaultCert = edgeDefaultCertPaths(paths.confDir);
    await write(defaultCert.certPath, cert.certPem);
    await write(defaultCert.keyPath, cert.keyPem, 0o600);
    for (const host of ["private.test", "public.test", "other.test"]) {
      await write(`/etc/letsencrypt/live/${host}/fullchain.pem`, cert.certPem);
      await write(`/etc/letsencrypt/live/${host}/privkey.pem`, cert.keyPem, 0o600);
    }
    for (const [name, encoded] of Object.entries(EMBEDDED_LUA))
      await write(
        `/usr/local/openresty/site/lualib/openship/${name}`,
        Buffer.from(encoded, "base64").toString(),
      );
    const ports = (text: string) =>
      text
        .replaceAll("listen 80", `listen ${httpPort}`)
        .replaceAll("listen 443", `listen ${tlsPort}`);
    await write(
      paths.confPath,
      ports(bakedEdgeNginxConf())
        .replace("worker_processes auto;", "user nobody;\nworker_processes 2;")
        .replace(/error_log .*?;/, "error_log /tmp/route-auth-error.log notice;"),
    );
    await write("/opt/openship/route-test/index.html", "private document");
    await write("/opt/openship/route-test/asset.js", "private javascript");
    await exec(`mkdir -p ${sq(paths.sitesDir)} && openresty`);
    // Isolated fake application. It can report received cookies but cannot see
    // the edge's signing key. The pressure endpoint exists in this fixture only.
    await write(
      `${paths.sitesDir}/_test_upstream.conf`,
      `server {
      listen 127.0.0.1:39482;
      header_filter_by_lua_block { }
      body_filter_by_lua_block { }
      location = /api/authorization {
        content_by_lua_block { ngx.print((ngx.var.http_authorization or "none") .. "|" .. (ngx.var.http_cookie or "none")) }
      }
      location = /api/error {
        content_by_lua_block {
          ngx.status = tonumber(ngx.var.arg_status) or 502
          ngx.header["Content-Type"] = "application/json"
          ngx.header["Content-Security-Policy"] = "default-src 'none'"
          ngx.print('{"error":"original app response"}')
        }
      }
      location = /api/compressed {
        content_by_lua_block {
          ngx.status = 502
          ngx.header["Content-Encoding"] = "gzip"
          ngx.print(ngx.decode_base64("${gzipSync("original compressed error").toString("base64")}"))
        }
      }
      # Test-only bridge to the loopback management listener.
      location = /api/test-rules { proxy_pass http://127.0.0.1:9145/rules; }
      location / {
        add_header Cache-Control "public, max-age=3600";
        content_by_lua_block { ngx.print(ngx.var.http_cookie or "none") }
      }
      location = /api/fill-limits {
        content_by_lua_block {
          local dict = ngx.shared.route_auth_limits
          dict:flush_all()
          dict:flush_expired()
          -- Fill each slab size, including room formerly occupied by counters.
          for _, size in ipairs({1024, 512, 256, 128, 64, 1}) do
            for i = 1, 100000 do
              if not dict:safe_add("fixture:" .. size .. ":" .. i, string.rep("x", size), 60) then break end
            end
          end
          ngx.print("full")
        }
      }
    }`,
    );
    const executor = {
      exec,
      writeFile: (p: string, content: string, opts?: { mode?: number }) =>
        write(p, ports(content), opts?.mode),
      readFile: (p: string) => exec(`cat ${sq(p)}`),
      exists: async (p: string) =>
        (await exec(`if test -e ${sq(p)}; then printf yes; fi`)) === "yes",
      mkdir: async (p: string) => {
        await exec(`mkdir -p ${sq(p)}`);
      },
      rm: async (p: string) => {
        await exec(`rm -rf ${sq(p)}`);
      },
      chmod: async (p: string, mode: number) => {
        await exec(`chmod ${mode.toString(8)} ${sq(p)}`);
      },
    } as unknown as RootChecked;
    nginx = new NginxProvider({ executor, paths, pinPaths: true, containerEdge: true });
    protection = await createRouteProtection(password);
    for (const host of ["public.test", "private.test", "other.test"])
      await nginx.registerRoute({
        domain: host,
        tls: true,
        terminatesTlsLocally: true,
        staticRoot: "/opt/openship/route-test",
        ...(host === "public.test" ? {} : { protection }),
        proxyLocations,
        redirects: [{ path: "/old", exact: true, destination: "/new", statusCode: 308 }],
        headerRules: [
          { path: "/", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
          {
            path: "/asset.js",
            exact: true,
            headers: [{ key: "CDN-Cache-Control", value: "public, max-age=86400" }],
          },
        ],
      });
    await settleReload();
  }, 120_000);
  afterAll(async () => {
    if (container) {
      try {
        const logs = await exec("tail -n 100 /tmp/route-auth-error.log");
        await writeFile(join(tmpdir(), "openship-route-auth-runtime.log"), logs);
      } finally {
        await container.remove({ force: true, v: true });
      }
    }
  });

  it.each([0, 10001])("reloads private configs owned by UID %i with unprivileged workers", async (uid) => {
    expect((await exec("id -u")).trim()).toBe("0");
    const processes = await exec("ps -o user,args");
    expect(processes).toMatch(/^root\s+.*nginx: master process/m);
    expect(processes).toMatch(/^nobody\s+.*nginx: worker process/m);
    const files = ["private-test.conf", "private-test.route.json"]
      .map((name) => sq(join(paths.sitesDir, name)));
    try {
      await exec(`chown ${uid} ${files.join(" ")}`);
      for (const path of files) {
        expect((await exec(`stat -c '%u:%a' ${path}`)).trim()).toBe(`${uid}:600`);
        await expect(exec(`cat ${path} > /dev/null`, { user: "nobody" })).rejects.toThrow(/Permission denied/);
      }
      await exec("openresty -t && openresty -s reload");
      await settleReload();
      expect((await ask("/", { host: "public.test" })).status).toBe(200);
      expect((await ask("/")).status).toBe(401);
    } finally {
      await exec(`chown 0 ${files.join(" ")}`);
    }
  });

  it("keeps public routes unchanged and blocks protected HTML, assets, APIs and forged HTTPS", async () => {
    expect((await ask("/", { host: "public.test" })).body).toBe("private document");
    const page = await ask("/");
    expect(page.status).toBe(401);
    expect(page.body).toContain("This site is private");
    expect(page.headers["cache-control"]).toBe("private, no-store");
    for (const path of ["/asset.js", "/api/secret", "/_openship/hooks/private"]) {
      expect((await ask(path, { headers: { Accept: "*/*" } })).status).toBe(401);
    }
    expect((await ask("/old")).status).toBe(401);
    expect((await ask("/old", { host: "public.test" })).status).toBe(308);
    const direct = await ask("/asset.js", {
      http: true,
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(direct.status).toBe(403);
  });

  it("checks the password off-thread and issues a bounded host-only browser session", async () => {
    expect((await login("incorrect-test-password")).status).toBe(401);
    const accepted = await login(password, "/docs/a%2Fb?x=1&x=2");
    expect(accepted.status).toBe(303);
    expect(accepted.headers.location).toBe("/docs/a%2Fb?x=1&x=2");
    const set = accepted.headers["set-cookie"]![0];
    expect(set).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(set).not.toContain("Domain=");
    cookie = set.split(";")[0];
    expect((await ask("/asset.js", { cookie })).body).toBe("private javascript");
    expect((await ask("/", { cookie })).body).toBe("private document");
    expect((await ask("/missing-spa-path", { cookie })).body).toBe("private document");
    expect((await ask("/", { host: "other.test", cookie })).status).toBe(401);
    expect((await ask("/", { cookie: cookie + "0" })).status).toBe(401);
    expect((await ask("/", { cookie: `${cookie}; ${cookie}` })).status).toBe(401);
    expect((await ask("/api/echo", { cookie: `${cookie}; app_session=kept` })).body).toContain(
      "app_session=kept",
    );
    expect((await ask("/api/echo", { cookie })).body).not.toContain("__Host-openship_route");
    expect((await ask("/old", { cookie })).status).toBe(308);
    for (const path of ["/", "/asset.js", "/api/echo", "/old"]) {
      const response = await ask(path, { cookie });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["cdn-cache-control"]).toBe("no-store");
    }
    const { createHmac } = await import("node:crypto");
    for (const expiry of [
      Math.floor(Date.now() / 1000) - 1,
      Math.floor(Date.now() / 1000) + 90000,
    ]) {
      const mac = createHmac("sha256", Buffer.from(protection.signingKey, "hex"))
        .update(`openship-route-v1\nsession\nprivate.test\n${protection.version}\n${expiry}`)
        .digest("hex");
      expect(
        (await ask("/asset.js", { cookie: `__Host-openship_route=${expiry}.${mac}` })).status,
      ).toBe(401);
    }
  });

  it("protects literal edge responses and prevents them from making private content cacheable", async () => {
    const payload = JSON.stringify({ host: "private.test", rules: [{ pathPrefix: "/virtual", spec: { response: normalizeEdgeResponse({ body: "private response", headers: { "Cache-Control": "public, max-age=3600" } }) } }] });
    try {
      const applied = await ask("/api/test-rules", { cookie, method: "POST", body: payload, headers: { "Content-Type": "application/json" } });
      expect(applied.status).toBe(200);
      expect(JSON.parse(applied.body)).toMatchObject({ ok: true, staticResponses: true });
      expect((await ask("/virtual")).status).toBe(401);
      const response = await ask("/virtual", { cookie });
      expect(response).toMatchObject({ status: 200, body: "private response" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      expect((await ask("/api/test-rules?host=private.test", { cookie, method: "DELETE" })).status).toBe(200);
    }
  });

  it("rejects cross-origin sign-in and unsafe return locations", async () => {
    const csrf = (await ask("/")).body.match(/name="csrf" value="([^"]+)"/)![1];
    for (const origin of ["https://attacker.test", "null"]) {
      expect(
        (
          await ask("/_openship/access", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ password, csrf, return: "/" }).toString(),
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await ask("/_openship/access", {
          method: "POST",
          headers: {
            Origin: "https://private.test",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ password, csrf, return: "//attacker.test" }).toString(),
        })
      ).status,
    ).toBe(400);
  });

  it("bounds expensive sign-in work while authenticated and public requests keep serving", async () => {
    const page = await ask("/");
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)![1];
    const attempts = Array.from({ length: 12 }, () =>
      ask("/_openship/access", {
        method: "POST",
        headers: {
          Origin: "https://private.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          password: "incorrect-test-password",
          return: "/",
          csrf,
        }).toString(),
      }),
    );
    const [privateAnswer, publicAnswer, ...results] = await Promise.all([
      ask("/asset.js", { cookie }),
      ask("/asset.js", { host: "public.test" }),
      ...attempts,
    ]);
    expect(privateAnswer.status).toBe(200);
    expect(publicAnswer.status).toBe(200);
    expect(results.some((result) => result.status === 429)).toBe(true);
    expect(results.every((result) => result.status === 401 || result.status === 429)).toBe(true);
  });

  it("measures warm public and authenticated requests over the same connection path", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 2 });
    try {
      const samples = { public: [] as number[], protected: [] as number[] };
      for (let i = 0; i < 120; i++) {
        for (const kind of ["public", "protected"] as const) {
          const start = performance.now();
          const response = await ask("/asset.js", {
            agent,
            ...(kind === "public" ? { host: "public.test" } : { cookie }),
          });
          if (i >= 20) samples[kind].push(performance.now() - start);
          expect(response.status).toBe(200);
        }
      }
      const median = (values: number[]) =>
        values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      console.info("Warm edge request median (ms, 100 samples each):", {
        public: median(samples.public),
        protected: median(samples.protected),
      });
    } finally {
      agent.destroy();
    }
  });

  it("preserves the lock on redeploy and full restart without a control plane", async () => {
    await nginx.registerRoute({
      domain: "private.test",
      tls: true,
      terminatesTlsLocally: true,
      staticRoot: "/opt/openship/route-test",
      proxyLocations,
    });
    await settleReload();
    expect((await ask("/asset.js")).status).toBe(401);
    expect((await ask("/asset.js", { cookie })).status).toBe(200);
    await exec("openresty -s stop");
    await exec("sleep 1; openresty");
    expect((await ask("/asset.js")).status).toBe(401);
    expect((await ask("/asset.js", { cookie })).status).toBe(200);
  });

  it("applies fallback changes live without exposing a protected custom error page", async () => {
    await write("/opt/openship/route-test/404.html", "private not-found page");
    for (const spaFallback of [false, true, undefined]) {
      await nginx.registerRoute({ domain: "private.test", tls: true, terminatesTlsLocally: true,
        staticRoot: "/opt/openship/route-test", spaFallback, proxyLocations });
      await settleReload();
      const anonymous = await ask("/missing-page");
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).not.toContain("private not-found page");
      const authenticated = await ask("/missing-page", { cookie });
      expect(authenticated.status).toBe(spaFallback === false ? 404 : 200);
      expect(authenticated.body).toBe(spaFallback === false ? "private not-found page" : "private document");
    }
  });

  it("uses browser authentication without HTML, strips credentials, and revokes cached passwords", async () => {
    const headers = { Authorization: `Basic ${Buffer.from(`viewer:${password}`).toString("base64")}` };
    const basic = { ...protection, mode: "basic" as const, username: "viewer" };
    try {
      await nginx.setRouteProtection("other.test", basic);
      await settleReload();
      const rejected = await ask("/", { host: "other.test" });
      expect(rejected.status).toBe(401);
      expect(rejected.headers["www-authenticate"]).toContain("Basic");
      expect(rejected.body).not.toContain("<html");
      expect((await ask("/", { host: "other.test", headers: { Authorization: `Basic ${Buffer.from("viewer:incorrect-password").toString("base64")}` } })).status).toBe(401);
      // Exercise both worker caches; a page load's assets must not spend another
      // PBKDF2 operation or the sign-in rate limit on every request.
      for (let i = 0; i < 12; i++) {
        const response = await ask("/api/authorization", { host: "other.test", headers, cookie: `${cookie}; app_session=kept` });
        expect(response).toMatchObject({ status: 200, body: "none|app_session=kept" });
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect((await ask("/", { host: "other.test", http: true, headers })).status).toBe(403);
      const rotated = { ...await createRouteProtection("replacement-test-password"), mode: "basic" as const, username: "viewer" };
      await nginx.setRouteProtection("other.test", rotated);
      await settleReload();
      expect((await ask("/", { host: "other.test", headers })).status).toBe(401);
    } finally {
      await nginx.setRouteProtection("other.test", protection);
      await settleReload();
    }
  });

  it("renders large custom sign-in HTML around the same CSRF-protected form", async () => {
    const loginHtml = `<!doctype html><title>Our private site</title><style>body{background:#111;color:#fff}</style><main>{{form}}</main><!--${"x".repeat(60000)}-->`;
    try {
      await nginx.setRouteProtection("private.test", { ...protection, loginHtml });
      await settleReload();
      const page = await ask("/");
      expect(page.status).toBe(401);
      expect(page.body).toContain("<title>Our private site</title>");
      expect(page.body).toContain('name="csrf"');
      expect(page.body).not.toContain("{{form}}");
      expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
      expect((await login()).status).toBe(303);
    } finally {
      await nginx.setRouteProtection("private.test", protection);
      await settleReload();
    }
  });

  it("serves maintenance at the edge for all methods and paths without bypassing authentication", async () => {
    const html = '<!doctype html><h1>Back after our upgrade</h1><script>document.title="Maintenance"</script>';
    const pages = compileEdgePages({ files: [{ id: "maintenance", name: "maintenance.html", html }], errors: [], maintenance: { enabled: true, pageId: "maintenance", retryAfter: 600 } })!;
    try {
      await nginx.setRouteEdgePages("private.test", pages);
      await settleReload();
      for (const path of ["/", "/api/error", "/old", "/asset.js", "/missing"]) {
        expect((await ask(path)).status).toBe(401);
        const response = await ask(path, { cookie });
        expect(response).toMatchObject({ status: 503, body: html });
        expect(response.headers["retry-after"]).toBe("600");
        expect(response.headers["cache-control"]).toBe("private, no-store");
      }
      expect((await ask("/api/error", { method: "POST", body: "data", cookie })).status).toBe(503);
      expect(await ask("/", { method: "HEAD", cookie })).toMatchObject({ status: 503, body: "" });
      expect((await ask("/_openship/access")).status).toBe(401);
      expect((await ask("/.well-known/acme-challenge/verify_123")).status).not.toBe(503);
      expect((await ask("/", { host: "public.test" })).status).toBe(200);
      // Changing the route target must retain maintenance, including a restart.
      await nginx.registerRoute({ domain: "private.test", tls: true, terminatesTlsLocally: true, staticRoot: "/opt/openship/route-test", proxyLocations });
      await exec("openresty -s stop && sleep 1 && openresty");
      expect((await ask("/", { cookie })).status).toBe(503);
      // A rejected update restores both the generated vhost and its durable state.
      await write(`${paths.sitesDir}/invalid.conf`, "not_an_nginx_directive;");
      await expect(nginx.setRouteEdgePages("private.test", null)).rejects.toThrow();
      expect(await nginx.getRouteEdgePages("private.test")).toEqual(pages);
      expect((await ask("/", { cookie })).status).toBe(503);
    } finally {
      await exec(`rm -f ${sq(`${paths.sitesDir}/invalid.conf`)}`);
      await nginx.setRouteEdgePages("private.test", null);
      await settleReload();
    }
    expect((await ask("/", { cookie })).status).toBe(200);
  });

  it("inherits server error pages, overrides per hostname, and keeps status codes and IP defaults", async () => {
    const serverHtml = `<!doctype html><h1>Server unavailable</h1><!--${"x".repeat(65000)}-->`;
    const hostHtml = '<!doctype html><h1>Project unavailable</h1>';
    const addressHtml = '<!doctype html><h1>Choose a connected domain</h1>';
    const config: EdgePages = { files: [
      { id: "error", name: "unavailable.html", html: serverHtml },
      { id: "address", name: "address.html", html: addressHtml },
    ], errors: [{ status: 502, pageId: "error" }, { status: 503, pageId: "error" }], defaultPageId: "address" };
    try {
      await nginx.setEdgePages(config);
      await nginx.setRouteEdgePages("private.test", { errors: { "502": hostHtml } });
      await settleReload();
      expect(await nginx.getEdgePages()).toEqual(config);
      expect(await ask("/api/error?status=502", { cookie })).toMatchObject({ status: 502, body: hostHtml });
      expect(await ask("/offline/", { cookie })).toMatchObject({ status: 502, body: hostHtml });
      const compressed = await ask("/api/compressed", { cookie });
      expect(compressed).toMatchObject({ status: 502, body: hostHtml });
      expect(compressed.headers["content-encoding"]).toBeUndefined();
      const inherited = await ask("/api/error?status=503", { cookie });
      expect(inherited).toMatchObject({ status: 503, body: serverHtml });
      expect(inherited.headers["content-type"]).toContain("text/html");
      expect(inherited.headers["content-security-policy"]).toBeUndefined();
      expect(inherited.headers["cache-control"]).toBe("private, no-store");
      expect(await ask("/api/error?status=502", { method: "HEAD", cookie })).toMatchObject({ status: 502, body: "" });
      expect(await ask("/api/error?status=502", { host: "public.test" })).toMatchObject({ status: 502, body: serverHtml });
      expect(await ask("/api/error?status=504", { cookie })).toMatchObject({ status: 504, body: '{"error":"original app response"}' });
      expect((await ask("/api/error?status=502")).status).toBe(401);
      expect(await ask("/", { host: "unmatched.test", http: true })).toMatchObject({ status: 404, body: addressHtml });
      expect(await ask("/", { host: "127.0.0.1", http: true })).toMatchObject({ status: 404, body: addressHtml });
      expect((await ask("/.well-known/acme-challenge/unknown", { host: "unmatched.test", http: true })).body).not.toContain("Choose a connected domain");
      await write(`${paths.sitesDir}/invalid.conf`, "not_an_nginx_directive;");
      await expect(nginx.setEdgePages({ files: [], errors: [] })).rejects.toThrow();
      expect(await nginx.getEdgePages()).toEqual(config);
    } finally {
      await exec(`rm -f ${sq(`${paths.sitesDir}/invalid.conf`)}`);
      await nginx.setEdgePages({ files: [], errors: [] });
      await nginx.setRouteEdgePages("private.test", null);
      await settleReload();
    }
    expect(await ask("/api/error?status=502", { host: "public.test" })).toMatchObject({ status: 502, body: '{"error":"original app response"}' });
  });

  it("invalidates old cookies and restores the previous lock after a rejected config update", async () => {
    protection = revokeRouteSessions(protection);
    await nginx.setRouteProtection("private.test", protection);
    await settleReload();
    expect((await ask("/asset.js", { cookie })).status).toBe(401);
    const next = await login();
    expect(next.status).toBe(303);
    cookie = next.headers["set-cookie"]![0].split(";")[0];
    // Syntactically invalid extra file makes the REAL nginx -t fail.
    await write(`${paths.sitesDir}/invalid.conf`, "not_an_nginx_directive;");
    await expect(nginx.setRouteProtection("private.test", null)).rejects.toThrow();
    const protectedFiles = ["private-test.conf", "private-test.route.json"]
      .map((name) => sq(join(paths.sitesDir, name)))
      .join(" ");
    expect((await exec(`stat -c '%a' ${protectedFiles}`)).trim().split("\n")).toEqual([
      "600",
      "600",
    ]);
    await exec(`rm ${sq(`${paths.sitesDir}/invalid.conf`)}`);
    await exec("openresty -t; openresty -s reload");
    expect((await ask("/asset.js")).status).toBe(401);
    expect((await ask("/asset.js", { cookie })).status).toBe(200);
  });

  it("fails closed when the authentication module is missing", async () => {
    const path = "/usr/local/openresty/site/lualib/openship/route_auth.lua";
    await exec(`mv ${path} ${path}.saved; openresty -s reload`);
    await settleReload();
    expect((await ask("/asset.js", { cookie })).status).toBe(500);
    expect((await ask("/asset.js", { host: "public.test" })).status).toBe(200);
    await exec(`mv ${path}.saved ${path}; openresty -s reload`);
    await nginx.setRouteProtection("private.test", null);
    await settleReload();
    expect((await ask("/asset.js")).status).toBe(200);
  });

  it("keeps established sessions private and denies new logins when rate-limit memory is full", async () => {
    await nginx.setRouteProtection("private.test", protection);
    await settleReload();
    expect((await ask("/api/fill-limits", { cookie })).body).toBe("full");
    expect((await ask("/asset.js", { cookie })).status).toBe(200);
    expect((await ask("/asset.js")).status).toBe(401);
    expect((await login()).status).toBe(429);
  });
});
