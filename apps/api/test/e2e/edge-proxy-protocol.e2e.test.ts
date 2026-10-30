/**
 * PROXY protocol on the HTTPS listener (#1050), against a real OpenResty.
 *
 * The real `NginxProvider` drives a running edge container through
 * `DockerEdgeExecutor`: every vhost, every shared include and every reload is what
 * the product writes and runs, inside the base image the edge is built FROM, with the
 * checked-in baked `nginx.conf`. Only the client side is test code: a TCP socket that
 * writes a PROXY v1/v2 header before the TLS ClientHello, like Traefik's
 * `proxyProtocol` on a passthrough TCP router.
 *
 * What text assertions cannot show, and this does:
 *   - nginx applies `proxy_protocol` per socket, so the one listen in the generated
 *     listener file must switch every :443 server, including the image's catch-all,
 *     with zero TLS vhosts, and without a "protocol options redefined" warning;
 *   - the realip trust list REPLACES the http-scope one at server scope, so a trusted
 *     PROXY peer does not also gain CF-Connecting-IP trust, on :443 or on :80;
 *   - on → trust change → off → on converges every vhost with no redeploy, and the
 *     socket and every :443 vhost switch in one reload;
 *   - a route write never moves the socket, and a transition one vhost cannot follow
 *     (here the Cloud host, whose own :443 block trusts X-Real-IP from anyone) is
 *     refused with every file and the running edge unchanged;
 *   - a refused batch, or a failed certificate install, leaves the previous mode and
 *     vhosts serving;
 *   - an invalid setting writes nothing: no vhost, no challenge token, no certificate.
 *
 * The trusted peer is MEASURED, not assumed: it is whatever address the edge sees
 * for this test's own connections (the Docker gateway, which differs between Docker
 * Desktop and a Linux CI runner). An untrusted list uses TEST-NET-3, which can never
 * be that address.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as http2Connect } from "node:http2";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DockerEdgeExecutor,
  DockerRuntime,
  EDGE_CHALLENGE_DIR,
  EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
  EDGE_PROXY_PROTOCOL_REAL_IP_NAME,
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  edgeDefaultCertPaths,
  rootChecked,
  type EdgeProxyProtocolSetting,
  type RouteConfig,
} from "@repo/adapters";
import { sanitizeEdgeVhosts } from "@repo/adapters/proxy";
import type Dockerode from "dockerode";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";
import { makeTestCert } from "../../../../packages/adapters/src/system/proxy/test-certs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LUA_SOURCE = join(REPO_ROOT, "packages/adapters/src/infra/lua");
const LUA_DIR = "/usr/local/openresty/site/lualib/openship";
const SITES = OPENRESTY_DEFAULT_PATHS.sitesDir;
const CONF_PATH = `${OPENRESTY_DEFAULT_PATHS.confDir}/nginx.conf`;
const { certPath: DEFAULT_CERT, keyPath: DEFAULT_KEY } = edgeDefaultCertPaths(
  OPENRESTY_DEFAULT_PATHS.confDir,
);
const READY = "/tmp/openship-e2e-ready";
const UPSTREAM_PORT = 9901;

const REAL = "real.example.com";
/** Sorts BEFORE the `_openship-…` listener file, so its plain `listen 443 ssl` is
 *  parsed first: the ordering in which a "protocol options redefined" warning would
 *  appear if nginx raised one. */
const DIGIT = "1st.example.com";
const BOOT = "boot.example.com";
const PLAIN = "plain.example.com";
/** Cloud-fronted: its vhost carries a server-scope X-Real-IP realip block of its own,
 *  and a second real_ip_header in that scope would be `[emerg]`. */
const CLOUDY = "cloudy.opsh.io";
const UNROUTED = "nope.example";
/** TEST-NET-3: never the address this test connects from. */
const UNTRUSTED_RANGE = "203.0.113.0/24";

/** Upstream stand-in: reports the client address the APP is told about. */
const UPSTREAM_CONF = `server {
    listen 127.0.0.1:${UPSTREAM_PORT};
    server_name upstream.invalid;
    location / {
        default_type text/plain;
        return 200 "xri=$http_x_real_ip\\n";
    }
}
`;

function heredoc(path: string, content: string): string {
  const delim = "OSH_EOF_6c1d";
  if (content.includes(delim)) throw new Error(`heredoc delimiter collides: ${path}`);
  return `cat > ${path} <<'${delim}'\n${content}\n${delim}\n`;
}

async function edgeBaseImage(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "apps/edge/Dockerfile"), "utf8");
  const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  if (!from) throw new Error("apps/edge/Dockerfile has no FROM line");
  return from;
}

/** The image's placeholder pair, made with the host openssl (the base image has none). */
async function placeholderCert(): Promise<{ cert: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openship-pp-cert-"));
  try {
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=openship-edge-default",
      "-out",
      cert,
      "-keyout",
      key,
    ]);
    return { cert: await readFile(cert, "utf8"), key: await readFile(key, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** PROXY protocol header announcing `src` as the client of a TCP4 connection. */
function proxyHeader(version: 1 | 2, src: string): Buffer {
  if (version === 1) return Buffer.from(`PROXY TCP4 ${src} 192.0.2.10 51000 443\r\n`);
  const header = Buffer.alloc(28);
  Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]).copy(
    header,
  );
  header[12] = 0x21; // v2, PROXY command
  header[13] = 0x11; // TCP over IPv4
  header.writeUInt16BE(12, 14);
  src.split(".").forEach((octet, i) => (header[16 + i] = Number(octet)));
  [192, 0, 2, 10].forEach((octet, i) => (header[20 + i] = octet));
  header.writeUInt16BE(51000, 24);
  header.writeUInt16BE(443, 26);
  return header;
}

interface TlsOptions {
  sni: string;
  host?: string;
  proxy?: { version: 1 | 2; src: string };
  headers?: Record<string, string>;
}

/** TCP connect, optional PROXY header, then TLS — the way a passthrough proxy does it. */
function openTls(port: number, opts: TlsOptions, alpn: string[]): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const raw: Socket = netConnect(port, "127.0.0.1", () => {
      if (opts.proxy) raw.write(proxyHeader(opts.proxy.version, opts.proxy.src));
      const tls = tlsConnect({
        socket: raw,
        servername: opts.sni,
        rejectUnauthorized: false,
        ALPNProtocols: alpn,
      });
      tls.once("secureConnect", () => resolve(tls));
      tls.once("error", reject);
      tls.once("close", () => reject(new Error("TLS connection closed before the handshake")));
    });
    raw.once("error", reject);
    raw.setTimeout(10_000, () => raw.destroy(new Error("TLS connection timed out")));
  });
}

/** One HTTP/1.1 request over {@link openTls}. */
async function askTls(
  port: number,
  opts: TlsOptions,
): Promise<{ status: number; body: string; certCn?: string }> {
  const tls = await openTls(port, opts, ["http/1.1"]);
  const cn = tls.getPeerCertificate()?.subject?.CN;
  const certCn = Array.isArray(cn) ? cn[0] : cn;
  const extra = Object.entries(opts.headers ?? {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  tls.write(
    `GET / HTTP/1.1\r\nHost: ${opts.host ?? opts.sni}\r\n${extra}Connection: close\r\n\r\n`,
  );
  const raw = await new Promise<string>((resolve, reject) => {
    let out = "";
    tls.on("data", (d: Buffer) => (out += d.toString("utf8")));
    tls.once("end", () => resolve(out));
    tls.once("error", reject);
  });
  const [head = "", ...body] = raw.split("\r\n\r\n");
  return { status: Number(head.split(" ")[1]), body: body.join("\r\n\r\n"), certCn };
}

/** One HTTP/2 request over {@link openTls}, refusing a silent fallback to HTTP/1.1. */
async function askH2(port: number, opts: TlsOptions): Promise<{ status: number; body: string }> {
  const tls = await openTls(port, opts, ["h2"]);
  expect(tls.alpnProtocol).toBe("h2");
  const session = http2Connect(`https://${opts.sni}`, { createConnection: () => tls });
  try {
    return await new Promise((resolve, reject) => {
      const req = session.request({ ":path": "/", ":authority": opts.sni });
      let status = 0;
      let body = "";
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (d: Buffer) => (body += d.toString("utf8")));
      req.on("end", () => resolve({ status, body }));
      req.on("error", reject);
      req.end();
    });
  } finally {
    session.close();
  }
}

/** Plain HTTP on :80 with an explicit Host. */
function askHttp(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { ...headers, Host: host } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${host}${path}`)));
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `openresty -s reload` returns before the new workers serve; retry until they do. */
async function eventually<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(200);
    }
  }
}

const xri = (body: string) => body.match(/xri=(\S*)/)?.[1];

/** Worker pids, and whether any old-generation worker is still draining. */
async function workersOf(executor: DockerEdgeExecutor) {
  const ps = await executor.exec("ps -o pid,args");
  const lines = ps.split("\n").filter((l) => l.includes("nginx: worker process"));
  return {
    pids: lines.map((l) => l.trim().split(/\s+/)[0]!),
    draining: lines.some((l) => l.includes("shutting down")),
  };
}

/**
 * Run an action that reloads the edge (possibly several times), then wait until the
 * workers are all new, none is draining, and the set has stayed the same for a
 * second. `openresty -s reload` returns once the signal is sent, so an older worker
 * generation can otherwise answer the next request with a previous config. That
 * race can both hide a missing reload and fail a correct one. The first assertion
 * after each change is also retried, and is chosen so the previous config cannot
 * satisfy it.
 */
async function settleReload<T>(executor: DockerEdgeExecutor, action: () => Promise<T>): Promise<T> {
  const before = (await workersOf(executor)).pids;
  const result = await action();
  let stable = "";
  let since = 0;
  await eventually(async () => {
    const now = await workersOf(executor);
    const key = now.pids.join(",");
    if (now.draining || !now.pids.length || now.pids.some((p) => before.includes(p))) {
      stable = "";
      throw new Error(`edge reload not settled: ${JSON.stringify({ before, now })}`);
    }
    if (key !== stable) {
      stable = key;
      since = Date.now();
    }
    if (Date.now() - since < 1_000) throw new Error("edge workers not yet stable");
  }, 20_000);
  return result;
}

/**
 * Boot a disposable edge from the base image with the checked-in baked config.
 *
 * `binds` mounts host directories into it. `seed` runs before OpenResty starts, through
 * a container-mode executor, so the baked config finds its placeholder pair and the Lua.
 */
async function startEdge(
  runtime: DockerRuntime,
  opts: { binds?: string[]; seed?: (executor: DockerEdgeExecutor) => Promise<void> } = {},
): Promise<{
  container: Dockerode.Container;
  ports: { http: number; https: number };
  executor: DockerEdgeExecutor;
}> {
  const image = await edgeBaseImage();
  await runtime.pullImage(image);
  const placeholder = await placeholderCert();
  const baked = await readFile(join(REPO_ROOT, "apps/edge/nginx.conf"), "utf8");

  // Boot only once the test has written certificates and Lua through the executor;
  // the baked config needs the placeholder pair to exist before it can load at all.
  const script =
    `set -e\n` +
    `mkdir -p ${dirname(DEFAULT_CERT)} ${SITES} ${LUA_DIR} /var/www/acme /etc/letsencrypt/live\n` +
    heredoc(DEFAULT_CERT, placeholder.cert) +
    heredoc(DEFAULT_KEY, placeholder.key) +
    heredoc(CONF_PATH, baked) +
    `while [ ! -f ${READY} ]; do sleep 0.1; done\n` +
    `openresty -t\n` +
    `exec openresty -g 'daemon off;'\n`;
  const container = await runtime.docker.createContainer({
    Image: image,
    Entrypoint: ["sh", "-c"],
    Cmd: [script],
    Tty: true,
    ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
    HostConfig: {
      PortBindings: {
        "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
      ...(opts.binds ? { Binds: opts.binds } : {}),
    },
  });
  await container.start();
  const info = await container.inspect();
  const portOf = (spec: string) => Number(info.NetworkSettings.Ports?.[spec]?.[0]?.HostPort);
  const ports = { http: portOf("80/tcp"), https: portOf("443/tcp") };
  const executor = new DockerEdgeExecutor({
    containerName: info.Id,
    socketPath: dockerSocketPath,
    fileMode: "container",
  });

  for (const name of await readdir(LUA_SOURCE)) {
    if (name.endsWith(".lua")) {
      await executor.writeFile(`${LUA_DIR}/${name}`, await readFile(join(LUA_SOURCE, name), "utf8"));
    }
  }
  await opts.seed?.(executor);
  await executor.exec(`touch ${READY}`);

  for (let i = 0; ; i++) {
    const state = await container.inspect();
    if (!state.State.Running) {
      const log = (await container.logs({ stdout: true, stderr: true, tail: 40 })).toString();
      throw new Error(`edge exited (${state.State.ExitCode}):\n${log}`);
    }
    try {
      await askHttp(ports.http, "/", UNROUTED);
      break;
    } catch (err) {
      if (i > 80) throw err;
      await sleep(250);
    }
  }
  return { container, ports, executor };
}

describeDockerE2E("edge PROXY protocol on :443, real OpenResty", () => {
  let runtime: DockerRuntime;
  let container: Dockerode.Container;
  let executor: DockerEdgeExecutor;
  let ports = { http: 0, https: 0 };
  /** The address the edge sees for this test's own connections. */
  let peer = "";

  const provider = (edgeProxyProtocol?: EdgeProxyProtocolSetting) =>
    new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      executor: rootChecked(
        executor,
        "e2e: commands and files go into a disposable edge container",
      ),
      pinPaths: true,
      containerEdge: true,
      ...(edgeProxyProtocol ? { edgeProxyProtocol } : {}),
    });
  const on = (...trusted: string[]): EdgeProxyProtocolSetting => ({ mode: "https", trusted });
  const OFF: EdgeProxyProtocolSetting = { mode: "off" };
  const upstream = `http://127.0.0.1:${UPSTREAM_PORT}`;
  const tlsRoute = (domain: string, extra: Partial<RouteConfig> = {}) =>
    ({
      domain,
      tls: true,
      terminatesTlsLocally: true,
      targetUrl: upstream,
      ...extra,
    }) as RouteConfig;

  const sitesContaining = async (needle: string) => {
    const out = await executor.exec(`grep -lF -- '${needle}' ${SITES}/*.conf 2>/dev/null || true`);
    return out
      .split("\n")
      .filter(Boolean)
      .map((p) => p.split("/").pop());
  };
  /** Every generated file in the sites directory, by name. */
  const sitesSnapshot = async () => {
    const names = (await executor.exec(`ls -1 ${SITES}`)).split("\n").filter(Boolean).sort();
    return Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await executor.readFile(`${SITES}/${n}`)])),
    );
  };
  const configTest = () => executor.exec(`openresty -t -c ${CONF_PATH} 2>&1`);

  const reloaded = <T>(action: () => Promise<T>) => settleReload(executor, action);
  const workers = () => workersOf(executor);

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    ({ container, ports, executor } = await startEdge(runtime, {
      seed: async (setup) => {
        await setup.writeFile(`${SITES}/upstream-standin.conf`, UPSTREAM_CONF);
        for (const domain of [REAL, DIGIT, CLOUDY]) {
          const pair = makeTestCert([domain]);
          await setup.writeFile(`/etc/letsencrypt/live/${domain}/fullchain.pem`, pair.certPem);
          await setup.writeFile(`/etc/letsencrypt/live/${domain}/privkey.pem`, pair.keyPem);
        }
        // Pre-seeded so ensureBootstrapCert reuses it: the base image lacks the openssl CLI
        // the edge image installs. The vhost is still the product's bootstrap shape.
        const seed = makeTestCert([BOOT]);
        await setup.writeFile(
          `/etc/letsencrypt/openship-bootstrap/${BOOT}/fullchain.pem`,
          seed.certPem,
        );
        await setup.writeFile(
          `/etc/letsencrypt/openship-bootstrap/${BOOT}/privkey.pem`,
          seed.keyPem,
        );
      },
    }));
  }, 300_000);

  afterAll(async () => {
    await container?.remove({ force: true }).catch(() => {});
    await runtime?.dispose().catch(() => {});
  });

  it("switches every vhost with the socket at once, refuses a partial switch, and rolls back", async () => {
    // ── Off: today's behaviour ───────────────────────────────────────────────
    const off = provider(OFF);
    await off.registerRoute({ domain: PLAIN, tls: false, targetUrl: upstream } as RouteConfig);
    await off.registerRoute(tlsRoute(REAL, { proxy: { http2: true } }));
    await off.registerRoute(tlsRoute(DIGIT));
    await off.registerRoute(tlsRoute(CLOUDY));
    await reloaded(() => off.registerRoute(tlsRoute(BOOT)));
    expect(await executor.readFile(`${SITES}/boot-example-com.conf`)).toContain(
      "openship-bootstrap-tls",
    );

    peer = xri((await askHttp(ports.http, "/", PLAIN)).body) ?? "";
    expect(peer).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(xri((await askTls(ports.https, { sni: REAL })).body)).toBe(peer);
    // A PROXY header on a plain-TLS listener is garbage before the ClientHello.
    await expect(
      askTls(ports.https, { sni: REAL, proxy: { version: 1, src: "198.51.100.7" } }),
    ).rejects.toThrow();
    const trusted = provider(on(peer));

    // ── A route write never moves the socket, even from a provider with it on ─
    await reloaded(() => trusted.registerRoute(tlsRoute(REAL, { proxy: { http2: true } })));
    expect(await executor.exists(`${SITES}/${EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME}`)).toBe(false);
    for (const sni of [REAL, DIGIT]) {
      expect(xri((await askTls(ports.https, { sni })).body)).toBe(peer);
    }

    // ── Refused: a vhost that cannot switch keeps EVERY vhost and the socket ──
    // The Cloud host is the one that matters: on a PROXY socket its unconverted
    // trust-all X-Real-IP block would let any peer name its own client.
    const sidecars = [DIGIT, CLOUDY].map((d) => `${SITES}/${d.replace(/\./g, "-")}.route.json`);
    const saved = await Promise.all(sidecars.map((path) => executor.readFile(path)));
    for (const path of sidecars) await executor.writeFile(path, "{");
    const before = await sitesSnapshot();
    const workersBefore = (await workers()).pids;
    const refused = await provider(on(UNTRUSTED_RANGE)).reapplyStoredRoutes();
    expect(refused.failed).toContainEqual({
      slug: EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
      reason: expect.stringMatching(/not enabled on port 443.*1st-example-com\.conf/),
    });
    expect(await sitesSnapshot()).toEqual(before);
    expect((await workers()).pids).toEqual(workersBefore);
    for (const sni of [REAL, DIGIT, CLOUDY]) {
      expect(xri((await askTls(ports.https, { sni })).body)).toBe(peer);
    }
    await expect(
      askTls(ports.https, { sni: CLOUDY, proxy: { version: 1, src: "198.51.100.10" } }),
    ).rejects.toThrow();
    for (const [i, path] of sidecars.entries()) await executor.writeFile(path, saved[i]!);

    // ── On: the edge ALONE is updated, from the stored routes, in ONE reload ──
    const applied = await reloaded(() => trusted.reapplyStoredRoutes());
    expect(applied.failed).toEqual([]);
    expect(applied.repaired.sort()).toEqual([DIGIT, BOOT, CLOUDY, REAL].sort());
    expect(await configTest()).not.toMatch(/\[warn\]|redefined/);

    for (const [version, src] of [
      [1, "198.51.100.7"],
      [2, "198.51.100.8"],
    ] as const) {
      for (const sni of [REAL, DIGIT, BOOT, CLOUDY]) {
        await eventually(async () => {
          const answer = await askTls(ports.https, { sni, proxy: { version, src } });
          expect({ sni, version, xri: xri(answer.body) }).toEqual({ sni, version, xri: src });
        });
      }
    }
    expect(
      await askH2(ports.https, { sni: REAL, proxy: { version: 2, src: "198.51.100.9" } }),
    ).toMatchObject({
      status: 200,
      body: "xri=198.51.100.9\n",
    });
    // The Cloud-fronted host keeps its own X-Real-IP trust on :80, where that front
    // connects, while its :443 block names the client from the PROXY header only.
    // (X-Forwarded-Proto: https, as that front sends, so the :80 block serves instead of
    // redirecting.)
    const cloudyHttp = await askHttp(ports.http, "/", CLOUDY, {
      "X-Real-IP": "9.9.9.9",
      "X-Forwarded-Proto": "https",
    });
    expect(xri(cloudyHttp.body)).toBe("9.9.9.9");
    const cloudyTls = await askTls(ports.https, {
      sni: CLOUDY,
      proxy: { version: 2, src: "198.51.100.7" },
      headers: { "X-Real-IP": "9.9.9.9" },
    });
    expect(xri(cloudyTls.body)).toBe("198.51.100.7");
    // A trusted PROXY peer gains no header trust on :443.
    const spoofed = await askTls(ports.https, {
      sni: REAL,
      proxy: { version: 1, src: "198.51.100.7" },
      headers: { "CF-Connecting-IP": "9.9.9.9", "X-Real-IP": "9.9.9.9" },
    });
    expect(xri(spoofed.body)).toBe("198.51.100.7");
    // Unknown SNI reaches the image's catch-all THROUGH the PROXY header.
    const unrouted = await askTls(ports.https, {
      sni: UNROUTED,
      proxy: { version: 2, src: "198.51.100.7" },
    });
    expect(unrouted).toMatchObject({ status: 404, certCn: "openship-edge-default" });
    expect(unrouted.body).toContain("Service not found");
    // TLS without the header is refused while the feature is on.
    await expect(askTls(ports.https, { sni: REAL })).rejects.toThrow();
    await expect(askTls(ports.https, { sni: UNROUTED })).rejects.toThrow();

    // :80 is untouched, and trusting the PROXY peer did not make it a header source.
    expect(
      xri((await askHttp(ports.http, "/", PLAIN, { "CF-Connecting-IP": "9.9.9.9" })).body),
    ).toBe(peer);
    expect((await askHttp(ports.http, "/", REAL)).status).toBe(301);
    expect([502, 504]).toContain(
      (await askHttp(ports.http, "/.well-known/acme-challenge/x", REAL)).status,
    );

    // ── Trust change: one shared file, no vhost re-rendered ──────────────────
    // The peer is ALSO made an http-scope header source (OPENSHIP_EDGE_TRUSTED_PROXIES),
    // so a PROXY list that merged with the inherited one instead of replacing it would
    // still trust this peer's PROXY header and its CF-Connecting-IP on :443.
    process.env.OPENSHIP_EDGE_TRUSTED_PROXIES = peer;
    try {
      const vhostBefore = await executor.readFile(`${SITES}/real-example-com.conf`);
      const elsewhere = provider(on(UNTRUSTED_RANGE));
      const moved = await reloaded(() => elsewhere.reapplyStoredRoutes());
      expect(moved.repaired).toEqual([]);
      expect(moved.failed).toEqual([]);
      expect(await executor.readFile(`${SITES}/real-example-com.conf`)).toBe(vhostBefore);
      await eventually(async () => {
        const answer = await askTls(ports.https, {
          sni: REAL,
          proxy: { version: 1, src: "198.51.100.7" },
          headers: { "CF-Connecting-IP": "9.9.9.9" },
        });
        expect(xri(answer.body)).toBe(peer);
      });
      // The http-scope list still governs :80, exactly as without this feature.
      expect(
        xri((await askHttp(ports.http, "/", PLAIN, { "CF-Connecting-IP": "9.9.9.9" })).body),
      ).toBe("9.9.9.9");
      // An untrusted peer cannot name a client with a header on an unconverted-looking
      // host either: every :443 block reads the PROXY header only.
      const forged = await askTls(ports.https, {
        sni: CLOUDY,
        proxy: { version: 1, src: "198.51.100.10" },
        headers: { "X-Real-IP": "9.9.9.9" },
      });
      expect(xri(forged.body)).toBe(peer);
    } finally {
      delete process.env.OPENSHIP_EDGE_TRUSTED_PROXIES;
    }
    expect((await reloaded(() => trusted.reapplyStoredRoutes())).failed).toEqual([]);

    // ── Invalid setting: refused before any write; the edge keeps serving ────
    const empty = provider({
      mode: "invalid",
      error: "OPENSHIP_EDGE_PROXY_PROTOCOL=https requires a list",
    });
    const unchanged = await sitesSnapshot();
    const token = "e2e-refused-token-1050";
    const certOnly = "certonly.example.com";
    await expect(empty.registerRoute(tlsRoute("new.example.com"))).rejects.toThrow(
      /requires a list/,
    );
    await expect(
      empty.serveEdgeChallenge({ host: "new.example.com", tokens: [token] }),
    ).rejects.toThrow(/requires a list/);
    await expect(empty.installCert(certOnly, makeTestCert([certOnly]))).rejects.toThrow(
      /requires a list/,
    );
    await expect(empty.reapplyStoredRoutes()).rejects.toThrow(/requires a list/);
    expect(await executor.exists(`${EDGE_CHALLENGE_DIR}/${token}`)).toBe(false);
    expect(await executor.exists(`/etc/letsencrypt/live/${certOnly}/fullchain.pem`)).toBe(false);
    expect(await sitesSnapshot()).toEqual(unchanged);

    // ── Rollback: a refused batch restores every vhost and both files ────────
    await executor.writeFile(`${SITES}/zz-broken.conf`, "server { this is not nginx }\n");
    const failedOff = await provider(OFF).reapplyStoredRoutes();
    expect(failedOff.failed).toContainEqual({
      slug: EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
      reason: expect.stringMatching(/not applied to port 443/),
    });
    await executor.rm(`${SITES}/zz-broken.conf`);
    expect(await sitesSnapshot()).toEqual(unchanged);
    const still = await askTls(ports.https, {
      sni: REAL,
      proxy: { version: 1, src: "198.51.100.7" },
    });
    expect(xri(still.body)).toBe("198.51.100.7");

    // ── A failed certificate install recovers what is on disk ────────────────
    // The env now says off, and the install's first reload fails. Its recovery must
    // not stage that setting again: PROXY stays on and plain TLS stays refused.
    const execOriginal = executor.exec.bind(executor);
    let failReload = true;
    executor.exec = async (command: string, ...rest) => {
      if (failReload && command.includes(" -s reload")) {
        failReload = false;
        throw new Error("injected transient reload failure");
      }
      return execOriginal(command, ...rest);
    };
    try {
      await reloaded(async () => {
        await expect(provider(OFF).installCert(REAL, makeTestCert([REAL]))).rejects.toThrow(
          "injected transient reload failure",
        );
      });
    } finally {
      executor.exec = execOriginal;
    }
    expect(await sitesSnapshot()).toEqual(unchanged);
    await eventually(async () => {
      const answer = await askTls(ports.https, { sni: REAL, proxy: { version: 2, src: "198.51.100.8" } });
      expect(xri(answer.body)).toBe("198.51.100.8");
    });
    await expect(askTls(ports.https, { sni: REAL })).rejects.toThrow();

    // ── Off: complete retirement ─────────────────────────────────────────────
    const disabled = await reloaded(() => provider(OFF).reapplyStoredRoutes());
    expect(disabled.failed).toEqual([]);
    expect(disabled.repaired.sort()).toEqual([DIGIT, BOOT, CLOUDY, REAL].sort());
    expect(await executor.exists(`${SITES}/${EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME}`)).toBe(false);
    expect(await executor.exists(`${SITES}/${EDGE_PROXY_PROTOCOL_REAL_IP_NAME}`)).toBe(false);
    expect(await sitesContaining("proxy_protocol")).toEqual([]);
    expect(await sitesContaining(EDGE_PROXY_PROTOCOL_REAL_IP_NAME.slice(0, -1))).toEqual([]);
    await eventually(async () => {
      expect(xri((await askTls(ports.https, { sni: REAL })).body)).toBe(peer);
    });
    await expect(
      askTls(ports.https, { sni: REAL, proxy: { version: 2, src: "198.51.100.7" } }),
    ).rejects.toThrow();
    // The Cloud host is back to its own trust on :443, as before the feature.
    const cloudyBack = await askTls(ports.https, { sni: CLOUDY, headers: { "X-Real-IP": "9.9.9.9" } });
    expect(xri(cloudyBack.body)).toBe("9.9.9.9");

    // ── On again ─────────────────────────────────────────────────────────────
    expect((await reloaded(() => trusted.reapplyStoredRoutes())).failed).toEqual([]);
    await eventually(async () => {
      const again = await askTls(ports.https, {
        sni: BOOT,
        proxy: { version: 2, src: "198.51.100.8" },
      });
      expect(xri(again.body)).toBe("198.51.100.8");
    });
  }, 300_000);

  it("keeps PROXY on the default listener with zero TLS vhosts, through an edge restart", async () => {
    const trusted = provider(on(peer));
    for (const domain of [REAL, DIGIT, BOOT, CLOUDY])
      await reloaded(() => trusted.removeRoute(domain));
    expect(await sitesContaining("listen 443 ssl;")).toEqual([]);

    const answer = await askTls(ports.https, {
      sni: UNROUTED,
      proxy: { version: 1, src: "198.51.100.7" },
    });
    expect(answer).toMatchObject({ status: 404, certCn: "openship-edge-default" });
    await expect(askTls(ports.https, { sni: UNROUTED })).rejects.toThrow();

    // `openship up` sanitizes the mounted sites dir before every edge start. The
    // listener must survive it, or the restarted edge drops PROXY until the next apply.
    await sanitizeEdgeVhosts(executor, SITES, () => {});
    expect(await executor.exists(`${SITES}/${EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME}`)).toBe(true);
    await container.restart({ t: 2 });
    await eventually(async () => {
      // Published ports are reassigned on restart, and may not be reported at once.
      const info = await container.inspect();
      ports.https = Number(info.NetworkSettings.Ports?.["443/tcp"]?.[0]?.HostPort);
      const answer = await askTls(ports.https, {
        sni: UNROUTED,
        proxy: { version: 2, src: "198.51.100.7" },
      });
      expect(answer.status).toBe(404);
    }, 30_000);
    await expect(askTls(ports.https, { sni: UNROUTED })).rejects.toThrow();
  }, 300_000);
});

/**
 * The same transitions with the file channel the Compose api uses: `fileMode: "mounted"`,
 * where vhosts, snapshots and restores go through THIS process's filesystem and only
 * `ls`, `grep`, `openresty -t` and the reload run in the container. Here the two sides
 * even name the directory differently (a host temp dir bind-mounted onto the
 * container's sites-enabled), so a snapshot or listing taken through the wrong channel
 * fails instead of passing by coincidence.
 */
describeDockerE2E("edge PROXY protocol on :443, mounted sites directory", () => {
  let runtime: DockerRuntime;
  let container: Dockerode.Container;
  let ports = { http: 0, https: 0 };
  let commands: DockerEdgeExecutor;
  let mounted: DockerEdgeExecutor;
  let hostSites = "";
  let hostLive = "";
  let peer = "";

  const provider = (edgeProxyProtocol: EdgeProxyProtocolSetting) =>
    new NginxProvider({
      paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir: hostSites },
      certDir: hostLive,
      executor: rootChecked(mounted, "e2e: host files bind-mounted into a disposable edge"),
      pinPaths: true,
      containerEdge: true,
      edgeProxyProtocol,
    });
  const upstream = `http://127.0.0.1:${UPSTREAM_PORT}`;
  const tlsRoute = (domain: string) =>
    ({ domain, tls: true, terminatesTlsLocally: true, targetUrl: upstream }) as RouteConfig;
  const reloaded = <T>(action: () => Promise<T>) => settleReload(commands, action);
  /** The host side of the sites directory, by name. */
  const hostSnapshot = async () => {
    const names = (await readdir(hostSites)).sort();
    return Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await readFile(join(hostSites, n), "utf8")])),
    );
  };

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    // realpath: Docker Desktop shares /private/var/folders, which /var/folders links to.
    const root = await realpath(await mkdtemp(join(tmpdir(), "openship-pp-mounted-")));
    hostSites = join(root, "sites-enabled");
    hostLive = join(root, "live");
    await mkdir(hostSites);
    await writeFile(join(hostSites, "upstream-standin.conf"), UPSTREAM_CONF);
    for (const domain of [REAL, CLOUDY]) {
      const pair = makeTestCert([domain]);
      await mkdir(join(hostLive, domain), { recursive: true });
      await writeFile(join(hostLive, domain, "fullchain.pem"), pair.certPem);
      await writeFile(join(hostLive, domain, "privkey.pem"), pair.keyPem);
    }
    // The vhost names certificates by their host path, so that path exists inside too.
    ({ container, ports, executor: commands } = await startEdge(runtime, {
      binds: [`${hostSites}:${SITES}`, `${hostLive}:${hostLive}:ro`],
    }));
    mounted = new DockerEdgeExecutor({
      containerName: (await container.inspect()).Id,
      socketPath: dockerSocketPath,
      fileMode: "mounted",
    });
  }, 300_000);

  afterAll(async () => {
    await container?.remove({ force: true }).catch(() => {});
    await runtime?.dispose().catch(() => {});
    if (hostSites) await rm(dirname(hostSites), { recursive: true, force: true }).catch(() => {});
  });

  it("switches, refuses and rolls back through the host filesystem", async () => {
    const off = provider({ mode: "off" });
    await off.registerRoute(tlsRoute(REAL));
    await reloaded(() => off.registerRoute(tlsRoute(CLOUDY)));
    peer = xri((await askTls(ports.https, { sni: REAL })).body) ?? "";
    expect(peer).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const trusted = provider({ mode: "https", trusted: [peer] });

    // Refused: the Cloud host's saved route is unreadable. Nothing changes on either side.
    const state = join(hostSites, "cloudy-opsh-io.route.json");
    const saved = await readFile(state, "utf8");
    await writeFile(state, "{");
    const before = await hostSnapshot();
    const refused = await trusted.reapplyStoredRoutes();
    expect(refused.failed).toContainEqual({
      slug: EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
      reason: expect.stringMatching(/not enabled on port 443.*cloudy-opsh-io\.conf/),
    });
    expect(await hostSnapshot()).toEqual(before);
    await expect(
      askTls(ports.https, { sni: CLOUDY, proxy: { version: 1, src: "198.51.100.10" } }),
    ).rejects.toThrow();
    await writeFile(state, saved);

    // On: both vhosts and the socket, one reload, from the host side.
    const applied = await reloaded(() => trusted.reapplyStoredRoutes());
    expect(applied).toMatchObject({ failed: [] });
    expect(applied.repaired.sort()).toEqual([CLOUDY, REAL].sort());
    for (const sni of [REAL, CLOUDY]) {
      await eventually(async () => {
        const answer = await askTls(ports.https, {
          sni,
          proxy: { version: 2, src: "198.51.100.8" },
          headers: { "X-Real-IP": "9.9.9.9" },
        });
        expect(xri(answer.body)).toBe("198.51.100.8");
      });
    }
    await expect(askTls(ports.https, { sni: REAL })).rejects.toThrow();

    // A batch the edge refuses is restored on the host, and PROXY keeps serving.
    const enabled = await hostSnapshot();
    await writeFile(join(hostSites, "zz-broken.conf"), "server { this is not nginx }\n");
    const failedOff = await provider({ mode: "off" }).reapplyStoredRoutes();
    expect(failedOff.failed).toContainEqual({
      slug: EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
      reason: expect.stringMatching(/not applied to port 443/),
    });
    await rm(join(hostSites, "zz-broken.conf"));
    expect(await hostSnapshot()).toEqual(enabled);
    const still = await askTls(ports.https, { sni: REAL, proxy: { version: 1, src: "198.51.100.7" } });
    expect(xri(still.body)).toBe("198.51.100.7");

    // Off.
    expect((await reloaded(() => provider({ mode: "off" }).reapplyStoredRoutes())).failed).toEqual([]);
    expect(await readdir(hostSites)).not.toContain(EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME);
    await eventually(async () => {
      expect(xri((await askTls(ports.https, { sni: REAL })).body)).toBe(peer);
    });
  }, 300_000);
});
