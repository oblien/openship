import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NginxProvider } from "./nginx";
import {
  EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
  EDGE_PROXY_PROTOCOL_REAL_IP_NAME,
  readEdgeProxyProtocolSetting,
  type EdgeProxyProtocolSetting,
} from "./edge-proxy-protocol";
import { OPENRESTY_DEFAULT_PATHS } from "./openresty-lua";
import { LocalExecutor } from "../system/local-executor";
import { rootChecked } from "../system/privilege";
import { makeTestCert } from "../system/proxy/test-certs";
import {
  containerEdgeProvider,
  localContainerEdgeProvider,
} from "../system/proxy/ensure-container-edge";
import type { CommandExecutor } from "../types";

const execFileAsync = promisify(execFile);

const env = (mode?: string, trusted?: string) => ({
  OPENSHIP_EDGE_PROXY_PROTOCOL: mode,
  OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED: trusted,
});

describe("reading OPENSHIP_EDGE_PROXY_PROTOCOL", () => {
  it.each([undefined, "", " off ", "OFF"])("is off for %j", (mode) => {
    expect(readEdgeProxyProtocolSetting(env(mode, "10.0.0.0/8"))).toEqual({ mode: "off" });
  });

  it("accepts IPv4/IPv6 addresses and network CIDRs, deduplicated in order", () => {
    expect(
      readEdgeProxyProtocolSetting(
        env("https", "192.168.1.153, 10.0.0.0/8 2001:db8::/32,::ffff:192.0.2.0/120 192.168.1.153"),
      ),
    ).toEqual({
      mode: "https",
      trusted: ["192.168.1.153", "10.0.0.0/8", "2001:db8::/32", "::ffff:192.0.2.0/120"],
    });
  });

  it.each([
    ["true", "10.0.0.1", /is not supported/],
    ["http", "10.0.0.1", /is not supported/],
    ["https", undefined, /requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED/],
    ["https", " , ", /requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED/],
    ["https", "0.0.0.0/0", /"0\.0\.0\.0\/0" trusts every address/],
    ["https", "10.0.0.1 ::/0", /"::\/0" trusts every address/],
    ["https", "10.0.0.1,traefik.lan", /"traefik\.lan" is not an IPv4\/IPv6 address/],
    ["https", "10.0.0.1/33", /invalid prefix length \(expected 1-32\)/],
    ["https", "2001:db8::/129", /invalid prefix length \(expected 1-128\)/],
    ["https", "10.0.0.1/8", /"10\.0\.0\.1\/8" has host bits set/],
    ["https", "2001:db8::1/64", /has host bits set/],
    ["https", "fe80::1%eth0", /is not an IPv4\/IPv6 address/],
    ["https", "010.0.0.1", /is not an IPv4\/IPv6 address/],
    ["https", "10.0.0.1;real_ip_header X", /is not an IPv4\/IPv6 address/],
  ])("refuses mode=%j trusted=%j instead of dropping the entry", (mode, trusted, message) => {
    const setting = readEdgeProxyProtocolSetting(env(mode, trusted));
    expect(setting.mode).toBe("invalid");
    expect(setting.mode === "invalid" && setting.error).toMatch(message);
  });
});

describe("only the LOCAL Compose edge reads the env", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The api can drive several servers. The env describes the listener and upstream
  // proxy of THIS machine, so a remote box's container edge must never be switched to
  // PROXY mode by it. That would refuse every visitor that box serves.
  it("applies it to localContainerEdgeProvider and never to containerEdgeProvider", async () => {
    vi.stubEnv("OPENSHIP_EDGE_PROXY_PROTOCOL", "https");
    vi.stubEnv("OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED", "192.0.2.10");
    const setting = (p: NginxProvider) =>
      (p as unknown as { edgeProxyProtocol?: EdgeProxyProtocolSetting }).edgeProxyProtocol;

    expect(setting(await localContainerEdgeProvider("openship-edge"))).toEqual({
      mode: "https",
      trusted: ["192.0.2.10"],
    });
    const remote = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async () => ({ code: 0, output: "" })),
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      exists: vi.fn(async () => true),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    } as unknown as CommandExecutor;
    expect(setting(await containerEdgeProvider(remote, "openship-edge"))).toBeUndefined();
  });
});

/**
 * Real files and atomic renames in a temp dir. Commands get a real `sh`, with the
 * container's sites path mapped to that dir, so the one-command drift check and the
 * directory listing run as written. Only `openresty` and `certbot` are simulated.
 */
describe("PROXY protocol transactions on the container edge", () => {
  const A = "a.example.com";
  const B = "b.example.com";
  const C = "c.example.com";
  const PLAIN = "plain.example.com";
  /** Cloud-fronted: its :443 block carries a trust-all X-Real-IP block while PROXY is off. */
  const CLOUDY = "cloudy.opsh.io";
  let root: string;
  let sites: string;
  let executor: LocalExecutor;
  let exec: MockInstance<LocalExecutor["exec"]>;
  let reloads: number;
  let failNextReload: boolean;
  const listener = () => join(sites, EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME);
  const realIp = () => join(sites, EDGE_PROXY_PROTOCOL_REAL_IP_NAME);
  const vhost = (domain: string) => join(sites, `${domain.replace(/\./g, "-")}.conf`);
  const sidecar = (domain: string) => join(sites, `${domain.replace(/\./g, "-")}.route.json`);
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  const INCLUDE = "_openship-proxy-protocol-realip.in[c];";
  const tls = (domain: string, port = 3001) => ({
    domain,
    tls: true,
    terminatesTlsLocally: true,
    targetUrl: `http://127.0.0.1:${port}`,
  });
  const on = (...trusted: string[]): EdgeProxyProtocolSetting => ({ mode: "https", trusted });
  const OFF: EdgeProxyProtocolSetting = { mode: "off" };
  const INVALID = readEdgeProxyProtocolSetting(env("https", ""));
  const provider = (edgeProxyProtocol?: EdgeProxyProtocolSetting) =>
    new NginxProvider({
      paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir: sites },
      certDir: join(root, "live"),
      challengeDir: join(root, "tokens"),
      executor: rootChecked(executor, "test: temporary filesystem with a simulated proxy"),
      pinPaths: true,
      containerEdge: true,
      ...(edgeProxyProtocol ? { edgeProxyProtocol } : {}),
    });
  /** Every file under the temp root, by path. */
  const tree = async () => {
    const files: Record<string, string> = {};
    for (const name of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!name.isFile()) continue;
      const path = join(name.parentPath, name.name);
      files[path] = await readFile(path, "utf8");
    }
    return files;
  };
  /** Bring the socket to `setting` the only way it can move: the global sweep. */
  const converge = async (setting: EdgeProxyProtocolSetting) => {
    const result = await provider(setting).reapplyStoredRoutes();
    expect(result.failed).toEqual([]);
    return result;
  };
  const transitionFailure = (result: { failed: { slug: string; reason: string }[] }) =>
    result.failed.find((f) => f.slug === EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME)?.reason;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openship-edge-pp-"));
    sites = join(root, "sites-enabled");
    await mkdir(sites);
    for (const domain of [A, B, C, CLOUDY]) {
      const pair = makeTestCert([domain]);
      await mkdir(join(root, "live", domain), { recursive: true });
      await writeFile(join(root, "live", domain, "fullchain.pem"), pair.certPem);
      await writeFile(join(root, "live", domain, "privkey.pem"), pair.keyPem);
    }
    await writeFile(join(root, "nginx.conf"), "http {\n}\n");
    reloads = 0;
    failNextReload = false;
    executor = new LocalExecutor();
    exec = vi.spyOn(executor, "exec").mockImplementation(async (command: string) => {
      // The container's paths contain "openresty" too; only the reload names its flag.
      if (command.includes(" -s reload")) {
        reloads++;
        if (failNextReload) {
          failNextReload = false;
          throw new Error("reload refused");
        }
        return "";
      }
      if (/\bcertbot\b/.test(command)) throw new Error("certbot is not simulated");
      // Only the quoted directory argument: the include line the drift check greps for
      // names the container path too, and must reach grep unchanged.
      const mapped = command.split(`'${OPENRESTY_DEFAULT_PATHS.sitesDir}'`).join(`'${sites}'`);
      return (await execFileAsync("sh", ["-c", mapped])).stdout;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("never moves the socket from a route write, whatever the env says", async () => {
    await provider(OFF).registerRoute(tls(B));
    // A new provider with the env on, on an edge whose other TLS vhosts predate it.
    await provider(on("192.0.2.10")).registerRoute(tls(A));
    expect(await read(listener())).toBeNull();
    expect(await read(realIp())).toBeNull();
    expect(await read(vhost(A))).not.toContain(INCLUDE);

    // Once the socket IS in PROXY mode, a route write follows it, even from a provider
    // that does not own the setting (a takeover builder driving the same directory).
    await converge(on("192.0.2.10"));
    await provider().registerRoute(tls(C));
    expect(await read(vhost(C))).toContain(INCLUDE);
    await provider(OFF).registerRoute(tls(A, 3002));
    expect(await read(listener())).not.toBeNull();
    expect(await read(vhost(A))).toContain(INCLUDE);
  });

  it("turns on with ONE reload that publishes the listener, the include and every :443 vhost", async () => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute(tls(CLOUDY));
    await off.registerRoute({ domain: PLAIN, tls: false, targetUrl: "http://127.0.0.1:3001" });
    const plain = await read(vhost(PLAIN));
    expect(await read(vhost(CLOUDY))).toMatch(/listen 443 ssl;[\s\S]*real_ip_header X-Real-IP;/);
    reloads = 0;

    const enabled = await converge(on("192.0.2.10"));
    expect(enabled.repaired.sort()).toEqual([A, CLOUDY]);
    expect(reloads).toBe(1);
    expect(await read(listener())).toContain("listen 443 ssl proxy_protocol;");
    expect(await read(realIp())).toContain("set_real_ip_from 192.0.2.10;");
    for (const domain of [A, CLOUDY]) {
      const https = (await read(vhost(domain)))!.split("listen 443 ssl;")[1]!;
      expect(https).toContain(`include /usr/local/openresty/nginx/conf/sites-enabled/${INCLUDE}`);
      expect(https).not.toContain("real_ip_header X-Real-IP;");
    }
    // :80 is untouched: the plain vhost is byte-identical, and the Cloud host's :80
    // block keeps the X-Real-IP trust its front needs.
    expect(await read(vhost(PLAIN))).toBe(plain);
    expect((await read(vhost(CLOUDY)))!.split("listen 443 ssl;")[0]).toContain(
      "real_ip_header X-Real-IP;",
    );

    reloads = 0;
    expect(await converge(on("192.0.2.10"))).toMatchObject({ repaired: [] });
    expect(reloads).toBe(0);
  });

  it.each([
    ["a corrupt saved route", async () => writeFile(sidecar(CLOUDY), "{")],
    ["a missing saved route", async () => rm(sidecar(CLOUDY))],
    [
      "an unknown :443 vhost that serves an upstream",
      async () =>
        writeFile(
          join(sites, "hand-written.conf"),
          "server {\n    listen 443 ssl;\n    server_name hand.example.com;\n    location / { proxy_pass http://127.0.0.1:9; }\n}\n",
        ),
    ],
    [
      "a saved route that no longer renders",
      async () =>
        writeFile(sidecar(CLOUDY), JSON.stringify({ ...tls(CLOUDY), targetUrl: "not a url" })),
    ],
  ])("refuses to turn on past %s, and changes nothing", async (_, breakIt) => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute(tls(CLOUDY));
    await breakIt();
    const before = await tree();
    reloads = 0;
    const writes = vi.spyOn(executor, "writeFile");

    const refused = await provider(on("203.0.113.0/24")).reapplyStoredRoutes();
    expect(await tree()).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(reloads).toBe(0);
    expect(refused.repaired).toEqual([]);
    expect(transitionFailure(refused)).toMatch(/PROXY protocol was not enabled on port 443/);
    expect(transitionFailure(refused)).toMatch(/cloudy-opsh-io\.conf|hand-written\.conf/);
  });

  it("does not let a dead-end :443 server without a saved route block the transition", async () => {
    await provider(OFF).registerRoute(tls(A));
    await writeFile(
      join(sites, "_default.conf"),
      "server {\n    listen 443 ssl default_server;\n    server_name _;\n    location / { return 404; }\n}\n",
    );
    expect((await converge(on("192.0.2.10"))).repaired).toEqual([A]);
    expect(await read(listener())).not.toBeNull();
  });

  it.each([
    ["turning it on", OFF, on("192.0.2.10")],
    ["a trust change", on("192.0.2.10"), on("198.51.100.0/24")],
    ["turning it off", on("192.0.2.10"), OFF],
  ])(
    "restores every vhost and both shared files when the reload for %s is refused",
    async (_, from, to) => {
      const off = provider(OFF);
      await off.registerRoute(tls(A));
      await off.registerRoute(tls(CLOUDY));
      await converge(from);
      const before = await tree();

      failNextReload = true;
      const result = await provider(to).reapplyStoredRoutes();
      expect(await tree()).toEqual(before);
      expect(result.repaired).toEqual([]);
      expect(transitionFailure(result)).toMatch(/not applied to port 443: .*reload refused/);
    },
  );

  it("restores the batch when publishing one of its files fails", async () => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute(tls(CLOUDY));
    const before = await tree();
    reloads = 0;
    // The vhosts are published first; the listener is the last file of the batch.
    const write = executor.writeFile.bind(executor);
    vi.spyOn(executor, "writeFile").mockImplementation(async (path, ...rest) => {
      if (path.startsWith(listener())) throw new Error("disk full");
      return write(path, ...rest);
    });

    const result = await provider(on("192.0.2.10")).reapplyStoredRoutes();
    expect(await tree()).toEqual(before);
    // Only the recovery reload, of the restored files.
    expect(reloads).toBe(1);
    expect(transitionFailure(result)).toMatch(/not applied to port 443: .*disk full/);
  });

  it("applies a trust change to every vhost with one reload and no vhost rewrite", async () => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute(tls(B));
    await converge(on("192.0.2.10"));
    const vhosts = [await read(vhost(A)), await read(vhost(B))];
    reloads = 0;

    const moved = await converge(on("198.51.100.0/24"));
    expect(moved.repaired).toEqual([]);
    expect(reloads).toBe(1);
    expect(await read(realIp())).toContain("set_real_ip_from 198.51.100.0/24;");
    expect(await read(realIp())).not.toContain("192.0.2.10");
    expect([await read(vhost(A)), await read(vhost(B))]).toEqual(vhosts);

    // Converged: the deploy-path sweep must not reload the edge every time it runs.
    await converge(on("198.51.100.0/24"));
    expect(reloads).toBe(1);
  });

  it("turns off completely, even past a vhost it cannot re-render", async () => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute(tls(B));
    await off.registerRoute(tls(CLOUDY));
    const cloudBefore = await read(vhost(CLOUDY));
    await converge(on("192.0.2.10"));
    await writeFile(sidecar(B), "{");

    const disabled = await provider(OFF).reapplyStoredRoutes();
    expect(await read(listener())).toBeNull();
    expect(disabled.repaired.sort()).toEqual([A, CLOUDY]);
    expect(transitionFailure(disabled)).toMatch(/turned off\. .*b-example-com\.conf/);
    expect(await read(realIp())).toBeNull();
    expect(await read(vhost(A))).not.toContain("proxy-protocol");
    // The Cloud host gets its own :443 trust back, byte for byte.
    expect(await read(vhost(CLOUDY))).toBe(cloudBefore);
    // Left behind with an include that now matches no file: plain TLS, inherited trust.
    expect(await read(vhost(B))).toContain(INCLUDE);

    reloads = 0;
    await provider(OFF).reapplyStoredRoutes();
    expect(reloads).toBe(0);
  });

  it("refuses every change while the setting is invalid, before any write or command", async () => {
    await provider(OFF).registerRoute(tls(A));
    await converge(on("192.0.2.10"));
    const before = await tree();
    const writes = vi.spyOn(executor, "writeFile");
    const removals = vi.spyOn(executor, "rm");
    exec.mockClear();
    reloads = 0;

    const invalid = provider(INVALID);
    const refused = /not changed: .*requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED/;
    const changes: [string, () => Promise<unknown>][] = [
      ["registerRoute", () => invalid.registerRoute(tls(B))],
      ["setRouteProtection", () => invalid.setRouteProtection(A, null)],
      ["removeRoute", () => invalid.removeRoute(A)],
      ["reapplyStoredRoutes", () => invalid.reapplyStoredRoutes()],
      ["serveEdgeChallenge", () => invalid.serveEdgeChallenge({ host: "new.example.com", tokens: ["tok-123456"] })],
      ["installCert (with a vhost)", () => invalid.installCert(A, makeTestCert([A]))],
      ["installCert (no vhost)", () => invalid.installCert("certonly.example.com", makeTestCert(["certonly.example.com"]))],
      ["provisionCert", () => invalid.provisionCert("new.example.com")],
      ["renewCert", () => invalid.renewCert(A)],
      ["activateCert", () => invalid.activateCert(A)],
      ["applyRateLimit", () => invalid.applyRateLimit({ rps: 10, burst: 5, whitelist: [] })],
    ];
    const outcomes: [string, unknown][] = [];
    for (const [name, change] of changes) {
      outcomes.push([name, await change().then((value) => ({ resolved: value }), (error: Error) => error.message)]);
    }

    expect(await tree()).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(reloads).toBe(0);
    for (const [name, outcome] of outcomes) expect(outcome, name).toMatch(refused);
    // Reads still answer.
    expect((await invalid.verifyCert(A)).verified).toBe(true);
    expect(await invalid.getRateLimitConfig()).toEqual({ rps: 0, burst: 0, whitelist: [] });
  });
});
