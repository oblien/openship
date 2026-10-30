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
 * container's sites path mapped to that dir, so the one-command drift check runs as
 * written. Only `openresty` itself is simulated.
 */
describe("PROXY protocol transactions on the container edge", () => {
  const A = "a.example.com";
  const B = "b.example.com";
  let root: string;
  let sites: string;
  let executor: LocalExecutor;
  let exec: MockInstance<LocalExecutor["exec"]>;
  let reloads: number;
  let failNextReload: boolean;
  const listener = () => join(sites, EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME);
  const realIp = () => join(sites, EDGE_PROXY_PROTOCOL_REAL_IP_NAME);
  const vhost = (domain: string) => join(sites, `${domain.replace(/\./g, "-")}.conf`);
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  const tls = (domain: string, port = 3001) => ({
    domain,
    tls: true,
    terminatesTlsLocally: true,
    targetUrl: `http://127.0.0.1:${port}`,
  });
  const on = (...trusted: string[]): EdgeProxyProtocolSetting => ({ mode: "https", trusted });
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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openship-edge-pp-"));
    sites = join(root, "sites-enabled");
    await mkdir(sites);
    for (const domain of [A, B]) {
      const pair = makeTestCert([domain]);
      await mkdir(join(root, "live", domain), { recursive: true });
      await writeFile(join(root, "live", domain, "fullchain.pem"), pair.certPem);
      await writeFile(join(root, "live", domain, "privkey.pem"), pair.keyPem);
    }
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

  it("refuses an invalid setting before writing anything, and keeps the previous edge", async () => {
    await provider(on("192.0.2.10")).registerRoute(tls(A));
    const before = {
      listener: await read(listener()),
      realIp: await read(realIp()),
      a: await read(vhost(A)),
    };
    const names = await readdir(sites);
    reloads = 0;
    // Not even a transient write: a rollback would restore the files, but the operator
    // asked for no change to land while the setting is wrong.
    const writes = vi.spyOn(executor, "writeFile");

    const invalid = provider(readEdgeProxyProtocolSetting(env("https", "")));
    await expect(invalid.registerRoute(tls(B))).rejects.toThrow(
      /not changed: .*requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED/,
    );
    await expect(invalid.removeRoute(A)).rejects.toThrow(
      /requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED/,
    );
    expect(await invalid.reapplyStoredRoutes()).toMatchObject({
      failed: [{ slug: "*", reason: expect.stringMatching(/requires/) }],
    });

    expect(reloads).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(await readdir(sites)).toEqual(names);
    expect({
      listener: await read(listener()),
      realIp: await read(realIp()),
      a: await read(vhost(A)),
    }).toEqual(before);
  });

  it.each([
    ["a trust change", on("198.51.100.0/24")],
    ["turning it off", { mode: "off" } as const],
  ])(
    "restores both shared files and the route when the reload for %s is refused",
    async (_, next) => {
      await provider(on("192.0.2.10")).registerRoute(tls(A));
      const before = {
        listener: await read(listener()),
        realIp: await read(realIp()),
        a: await read(vhost(A)),
      };
      expect(before.realIp).toContain("set_real_ip_from 192.0.2.10;");

      failNextReload = true;
      await expect(provider(next).registerRoute(tls(A, 3002))).rejects.toThrow("reload refused");

      expect({
        listener: await read(listener()),
        realIp: await read(realIp()),
        a: await read(vhost(A)),
      }).toEqual(before);
      expect((await readdir(sites)).some((name) => name.includes(".tmp-"))).toBe(false);
    },
  );

  it("applies a trust change to every vhost with one reload and no vhost rewrite", async () => {
    const first = provider(on("192.0.2.10"));
    await first.registerRoute(tls(A));
    await first.registerRoute(tls(B));
    const vhosts = [await read(vhost(A)), await read(vhost(B))];
    reloads = 0;

    const moved = provider(on("198.51.100.0/24"));
    expect(await moved.reapplyStoredRoutes()).toMatchObject({ repaired: [], failed: [] });
    expect(reloads).toBe(1);
    expect(await read(realIp())).toContain("set_real_ip_from 198.51.100.0/24;");
    expect(await read(realIp())).not.toContain("192.0.2.10");
    expect([await read(vhost(A)), await read(vhost(B))]).toEqual(vhosts);

    // Converged: the deploy-path sweep must not reload the edge every time it runs.
    await moved.reapplyStoredRoutes();
    expect(reloads).toBe(1);
  });

  it("turns off completely, and a provider without the setting leaves the files alone", async () => {
    const enabled = provider(on("192.0.2.10"));
    await enabled.registerRoute(tls(A));
    await enabled.registerRoute(tls(B));
    expect(await read(vhost(A))).toContain("_openship-proxy-protocol-realip.in[c];");

    // A provider that does not own this setting (a remote or takeover builder driving
    // the same directory) neither removes the PROXY state nor writes the include.
    await provider().registerRoute(tls("c.example.com"));
    expect(await read(listener())).not.toBeNull();
    expect(await read(join(sites, "c-example-com.conf"))).not.toContain("proxy-protocol");

    const disabled = await provider({ mode: "off" }).reapplyStoredRoutes();
    expect(disabled.failed).toEqual([]);
    expect(disabled.repaired.sort()).toEqual([A, B]);
    expect(await read(listener())).toBeNull();
    expect(await read(realIp())).toBeNull();
    for (const domain of [A, B]) expect(await read(vhost(domain))).not.toContain("proxy-protocol");

    reloads = 0;
    await provider({ mode: "off" }).reapplyStoredRoutes();
    expect(reloads).toBe(0);
  });

  it("re-renders only the :443 blocks that lack the include when it is turned on", async () => {
    const off = provider({ mode: "off" });
    await off.registerRoute(tls(A));
    await off.registerRoute({ domain: B, tls: false, targetUrl: "http://127.0.0.1:3001" });
    const plain = await read(vhost(B));

    const enabled = await provider(on("192.0.2.10")).reapplyStoredRoutes();
    expect(enabled).toMatchObject({ repaired: [A], failed: [] });
    expect(await read(vhost(A))).toMatch(
      /listen 443 ssl;[\s\S]*include \/usr\/local\/openresty\/nginx\/conf\/sites-enabled\/_openship-proxy-protocol-realip\.in\[c\];/,
    );
    // :80 is untouched: the plain vhost is byte-identical and its block never includes it.
    expect(await read(vhost(B))).toBe(plain);
    expect((await read(vhost(A)))!.split("server {")[1]).not.toContain("proxy-protocol");
    expect(await read(listener())).toContain("listen 443 ssl proxy_protocol;");
  });
});
