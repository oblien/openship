import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NginxProvider } from "./nginx";
import {
  EDGE_CONFIG_JOURNAL_NAME,
  EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME,
  EDGE_PROXY_PROTOCOL_REAL_IP_NAME,
  EdgeConfigRecoveryError,
  inspectHttpsVhost,
  readEdgeProxyProtocolSetting,
  type EdgeProxyProtocolSetting,
} from "./edge-proxy-protocol";
import { OPENRESTY_DEFAULT_PATHS, edgeDefaultCatchAllConf } from "./openresty-lua";
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

describe("reading a sites-enabled file for its :443 servers", () => {
  const server = (body: string) => `server {\n${body}\n}\n`;

  it.each([
    ["a quoted port", 'listen "443" ssl;'],
    ["a quoted IPv6 address", "listen '[::]:443' ssl;"],
    ["quoted parameters", 'listen "*:443" "ssl";'],
    ["a host and port", "listen 0.0.0.0:443 ssl;"],
    ["a listen after a comment ending in a quote", "# don't\n    listen 443 ssl;"],
  ])("finds a :443 listener spelled with %s", (_, listen) => {
    expect(
      inspectHttpsVhost(server(`    ${listen}\n    location / { proxy_pass http://127.0.0.1:1; }`))
        .https,
    ).toBe("yes");
  });

  it("follows the syntax Openship's own vhosts use", () => {
    const conf = server(`    listen 443 ssl;
    set $x "a;b{c}";
    if ($http_x_forwarded_proto = "https") { set $y 1; }
    add_header X-Var \${host}-x;
    server_rewrite_by_lua_block {
        local s = "}" -- a brace in a string } and a comment
        ngx.var.openship_route_auth = '{'
        --[[ } ]] local t = [==[ } ]==]
    }
    location / { proxy_pass http://127.0.0.1:1; }`);
    expect(inspectHttpsVhost(conf)).toMatchObject({
      https: "yes",
      returnOnly: false,
      reason: expect.stringMatching(/not provably/),
    });
  });

  it.each([
    [
      "a server-scope include",
      server(
        "    listen 443 ssl;\n    server_name a;\n    include /etc/nginx/app.conf;\n    return 404;",
      ),
      "yes",
    ],
    [
      "a listener from an include",
      server("    server_name a;\n    include /etc/nginx/listen-443.conf;\n    return 404;"),
      "unknown",
    ],
    ["an include outside any server", "include /etc/nginx/more-sites/*.conf;\n", "unknown"],
    ["inherited static content", server("    listen 443 ssl;\n    server_name a;"), "yes"],
    [
      "a location that does not return",
      server("    listen 443 ssl;\n    location / { return 404; }\n    location /x { }"),
      "yes",
    ],
    [
      "a directive that may serve",
      server("    listen 443 ssl;\n    location / { return 404; }\n    error_page 404 /x.html;"),
      "yes",
    ],
    ["an unclosed quote", server('    listen "443 ssl;'), "unknown"],
  ])("does not prove %s inert", (_, conf, https) => {
    expect(inspectHttpsVhost(conf)).toMatchObject({ https, returnOnly: false });
  });

  it.each([
    [
      "a server-scope return",
      server("    listen 443 ssl default_server;\n    server_name _;\n    return 444;"),
    ],
    ["the edge catch-all", edgeDefaultCatchAllConf({ certPath: "/c.pem", keyPath: "/k.pem" })],
  ])("proves %s inert", (_, conf) => {
    expect(inspectHttpsVhost(conf)).toMatchObject({ https: "yes", returnOnly: true });
  });

  it("does not count a :80 or unix listener", () => {
    expect(
      inspectHttpsVhost(
        server("    listen 80;\n    listen unix:/run/443.sock;\n    location / { root /srv; }"),
      ).https,
    ).toBe("no");
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

  it.each<[string, () => Promise<unknown>]>([
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
    ...(
      [
        [
          "a quoted :443 listener",
          `    listen "443" ssl;\n    location / { proxy_pass http://127.0.0.1:9; }`,
        ],
        [
          "a quoted IPv6 :443 listener",
          `    listen '[::]:443' ssl;\n    location / { proxy_pass http://127.0.0.1:9; }`,
        ],
        [
          "content from an include",
          `    listen 443 ssl;\n    include /etc/nginx/snippets/app.conf;`,
        ],
        [
          "a :443 listener from an include",
          `    include /etc/nginx/snippets/listen-443.conf;\n    location / { proxy_pass http://127.0.0.1:9; }`,
        ],
        ["inherited static content", `    listen 443 ssl;`],
      ] as const
    ).map(([what, body]): [string, () => Promise<unknown>] => [
      `an unknown vhost with ${what}`,
      async () =>
        writeFile(
          join(sites, "hand-written.conf"),
          `server {\n    server_name hand.example.com;\n${body}\n}\n`,
        ),
    ]),
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

  it("is not blocked by Openship's own auxiliary files or an HTTP-only vhost", async () => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute({ domain: PLAIN, tls: false, targetUrl: "http://127.0.0.1:3001" });
    await off.serveEdgeChallenge({ host: "challenge.example.com" });
    await writeFile(
      join(sites, "_carried-default.conf"),
      edgeDefaultCatchAllConf({ certPath: "/etc/ssl/a.pem", keyPath: "/etc/ssl/a.key" }),
    );
    await writeFile(
      join(sites, "hand-http.conf"),
      "server {\n    listen 80;\n    server_name hand.example.com;\n    location / { proxy_pass http://127.0.0.1:9; }\n}\n",
    );
    expect((await converge(on("192.0.2.10"))).repaired).toEqual([A]);
    expect(await read(listener())).not.toBeNull();
  });

  it("re-renders, in the drift pass, a route whose :443 listener the transition would have selected", async () => {
    const off = provider(OFF);
    await off.registerRoute(tls(A));
    await off.registerRoute(tls(B));
    await converge(on("192.0.2.10"));
    // Hand-edited: same server, its listener quoted, its include gone.
    const edited = (await read(vhost(B)))!
      .replace("listen 443 ssl;", 'listen "443" ssl;')
      .replace(/^.*_openship-proxy-protocol-realip\.in\[c\];\n/m, "");
    expect(edited).not.toContain(INCLUDE);
    await writeFile(vhost(B), edited);

    expect((await converge(on("192.0.2.10"))).repaired).toEqual([B]);
    expect(await read(vhost(B))).toContain(INCLUDE);
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

  describe("when a failed change cannot be rolled back", () => {
    const journal = () => join(sites, EDGE_CONFIG_JOURNAL_NAME);
    /** Publishing the listener fails, then restoring vhost A fails too. */
    const breakTurningOn = () => {
      const write = executor.writeFile.bind(executor);
      let aWrites = 0;
      return vi.spyOn(executor, "writeFile").mockImplementation(async (path, ...rest) => {
        if (path.startsWith(listener())) throw new Error("disk full");
        // The first write of A publishes it; the second is its restore.
        if (path.startsWith(vhost(A)) && ++aWrites === 2) throw new Error("read-only file system");
        return write(path, ...rest);
      });
    };
    const setUp = async () => {
      const off = provider(OFF);
      await off.registerRoute(tls(A));
      await off.registerRoute(tls(B));
      // Stale, so the per-route pass would rewrite and reload it if the sweep went on.
      await writeFile(vhost(C), "server {\n    listen 80;\n    server_name c.example.com;\n}\n");
      await writeFile(sidecar(C), JSON.stringify({ ...tls(C), tls: false }));
      return tree();
    };

    it("stops the sweep with the journal kept, and nothing reloaded or written after it", async () => {
      const before = await setUp();
      const writes = breakTurningOn();
      reloads = 0;

      const sweep = provider(on("192.0.2.10")).reapplyStoredRoutes();
      await expect(sweep).rejects.toBeInstanceOf(EdgeConfigRecoveryError);
      await expect(sweep).rejects.toThrow(
        /rollback failed: .*read-only file system.*Retry routing/,
      );
      expect(reloads).toBe(0);
      // The per-route pass never ran: C is still the stale file.
      expect(await read(vhost(C))).toBe(before[vhost(C)]);
      expect(writes.mock.calls.some(([path]) => path.startsWith(vhost(C)))).toBe(false);
      // The journal records A's previous file and is owner-only.
      const recorded = JSON.parse((await read(journal()))!) as {
        files: { path: string; content?: string }[];
      };
      expect(recorded.files.find((f) => f.path === vhost(A))?.content).toBe(before[vhost(A)]);
      expect((await stat(journal())).mode & 0o777).toBe(0o600);
    });

    it("refuses every change from any provider until recovered, then recovers to the previous files", async () => {
      const before = await setUp();
      const writes = breakTurningOn();
      await provider(on("192.0.2.10"))
        .reapplyStoredRoutes()
        .catch(() => undefined);
      writes.mockRestore();
      const halfRestored = await tree();
      expect(halfRestored[vhost(A)]).not.toBe(before[vhost(A)]);
      reloads = 0;
      const writeCalls = vi.spyOn(executor, "writeFile");

      // A fresh provider, with the feature on or off, or one that does not own the setting:
      // none reads the half-restored files as a mode and none writes or reloads.
      for (const fresh of [provider(on("192.0.2.10")), provider(OFF), provider()]) {
        const refusals = await Promise.all(
          [
            () => fresh.registerRoute(tls(B, 3002)),
            () => fresh.removeRoute(B),
            () => fresh.serveEdgeChallenge({ host: "new.example.com" }),
            () => fresh.installCert(A, makeTestCert([A])),
            () => fresh.provisionCert("new.example.com"),
            () => fresh.renewCert(A),
            () => fresh.activateCert(A),
            () => fresh.applyRateLimit({ rps: 10, burst: 5, whitelist: [] }),
            () => fresh.dnsChallengeProvider(),
          ].map((change) =>
            change().then(
              () => null,
              (error: Error) => error,
            ),
          ),
        );
        for (const error of refusals) expect(error).toBeInstanceOf(EdgeConfigRecoveryError);
      }
      expect(writeCalls).not.toHaveBeenCalled();
      expect(reloads).toBe(0);
      expect(await tree()).toEqual(halfRestored);

      // Recovery: the sweep restores every recorded file, validates and reloads, and only
      // then removes the journal. With the feature off, the socket stays plain, and the
      // sweep goes on to its per-route pass (the stale C: one more reload).
      writeCalls.mockRestore();
      const recovered = await provider(OFF).reapplyStoredRoutes();
      expect(recovered).toMatchObject({ recovered: true, repaired: [C], failed: [] });
      expect(reloads).toBe(2);
      expect(await read(journal())).toBeNull();
      expect(await read(vhost(B))).toBe(before[vhost(B)]);
      expect(await read(vhost(A))).toBe(before[vhost(A)]);
      expect(await read(listener())).toBeNull();
      expect(await read(realIp())).toBeNull();
    });

    it("keeps the journal and reloads nothing when the recovery cannot restore a file", async () => {
      await setUp();
      const writes = breakTurningOn();
      await provider(on("192.0.2.10"))
        .reapplyStoredRoutes()
        .catch(() => undefined);
      writes.mockRestore();
      const stuck = await tree();
      reloads = 0;
      const write = executor.writeFile.bind(executor);
      vi.spyOn(executor, "writeFile").mockImplementation(async (path, ...rest) => {
        if (path.startsWith(vhost(A))) throw new Error("still read-only");
        return write(path, ...rest);
      });

      await expect(provider(OFF).reapplyStoredRoutes()).rejects.toThrow(
        /Could not restore .*still read-only.*Nothing was reloaded/,
      );
      expect(reloads).toBe(0);
      expect(await read(journal())).toBe(stuck[journal()]);
    });

    it("does not lock the edge when every file is restored but the edge still refuses to reload", async () => {
      // An unrelated broken vhost: the switch's reload fails, and so does the recovery
      // reload of the restored files. Nothing is half restored, so nothing is journaled.
      const before = await setUp();
      exec.mockImplementation(async (command: string) => {
        if (command.includes(" -s reload")) {
          reloads++;
          throw new Error("unrelated vhost is invalid");
        }
        const mapped = command.split(`'${OPENRESTY_DEFAULT_PATHS.sitesDir}'`).join(`'${sites}'`);
        return (await execFileAsync("sh", ["-c", mapped])).stdout;
      });

      const result = await provider(on("192.0.2.10")).reapplyStoredRoutes();
      expect(transitionFailure(result)).toMatch(
        /not applied to port 443: .*rollback failed: unrelated/,
      );
      expect(await read(journal())).toBeNull();
      expect(await read(vhost(A))).toBe(before[vhost(A)]);
      expect(await read(listener())).toBeNull();
      await expect(provider(OFF).registerRoute(tls(B, 3002))).rejects.not.toBeInstanceOf(
        EdgeConfigRecoveryError,
      );
    });

    it("changes nothing when the journal itself cannot be written", async () => {
      await setUp();
      const before = await tree();
      const write = executor.writeFile.bind(executor);
      vi.spyOn(executor, "writeFile").mockImplementation(async (path, ...rest) => {
        if (path.startsWith(journal())) throw new Error("no space for the journal");
        return write(path, ...rest);
      });
      reloads = 0;

      const result = await provider(on("192.0.2.10")).reapplyStoredRoutes();
      expect(transitionFailure(result)).toMatch(
        /not applied to port 443: .*no space for the journal/,
      );
      expect(reloads).toBe(0);
      expect(await read(listener())).toBeNull();
      expect(await read(vhost(A))).toBe(before[vhost(A)]);
      expect(await read(journal())).toBeNull();
    });
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
      ["dnsChallengeProvider", () => invalid.dnsChallengeProvider()],
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
