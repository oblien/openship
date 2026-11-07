import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NginxProvider } from "./nginx";
import { LocalExecutor } from "../system/local-executor";
import { rootChecked } from "../system/privilege";
import { makeTestCert } from "../system/proxy/test-certs";
import { OPENRESTY_DEFAULT_PATHS } from "./openresty-lua";
import { EDGE_CONTAINER_REAL_IP_CONF_NAME } from "./edge-real-ip";
import type { RouteConfig } from "../types";

// Real files and renames; only the running edge is simulated, so every `exec` is a reload.
const DOMAIN = "shop.example.com";
const route = (port = 3001): RouteConfig => ({
  domain: DOMAIN,
  tls: false,
  targetUrl: `http://127.0.0.1:${port}`,
});

let root: string;
let sites: string;
let certDir: string;
let executor: LocalExecutor;
let reloads: MockInstance<LocalExecutor["exec"]>;
let writes: MockInstance<LocalExecutor["writeFile"]>;

const confPath = () => join(sites, "shop-example-com.conf");
const statePath = () => join(sites, "shop-example-com.route.json");

/** A provider as one deployment builds it. */
function provider() {
  return new NginxProvider({
    paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir: sites },
    certDir,
    challengeDir: join(root, "tokens"),
    executor: rootChecked(executor, "test: temporary filesystem with a simulated edge"),
    pinPaths: true,
    containerEdge: true,
  });
}

function resetCounts() {
  reloads.mockClear();
  writes.mockClear();
}

async function installCert() {
  const pair = makeTestCert([DOMAIN], { days: 60 });
  await mkdir(join(certDir, DOMAIN), { recursive: true });
  await writeFile(join(certDir, DOMAIN, "fullchain.pem"), pair.certPem);
  await writeFile(join(certDir, DOMAIN, "privkey.pem"), pair.keyPem, { mode: 0o600 });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-edge-idempotent-"));
  sites = join(root, "sites-enabled");
  certDir = join(root, "certs", "live");
  await mkdir(sites);
  executor = new LocalExecutor();
  reloads = vi.spyOn(executor, "exec").mockResolvedValue("");
  writes = vi.spyOn(executor, "writeFile");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("unchanged edge writes", () => {
  it("re-registering an unchanged route writes nothing and does not reload", async () => {
    const nginx = provider();
    await nginx.registerRoute(route());
    expect(reloads).toHaveBeenCalledTimes(1);
    resetCounts();

    await nginx.registerRoute(route());

    expect(writes).not.toHaveBeenCalled();
    expect(reloads).not.toHaveBeenCalled();
  });

  it("a new provider confirms once with a reload before it trusts the disk", async () => {
    await provider().registerRoute(route());
    resetCounts();

    // The next deployment: same files, but nothing yet shows the edge loaded them.
    const next = provider();
    await next.registerRoute(route());
    expect(writes).not.toHaveBeenCalled();
    expect(reloads).toHaveBeenCalledTimes(1);

    await next.registerRoute(route());
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("still writes and reloads when the route changes", async () => {
    const nginx = provider();
    await nginx.registerRoute(route(3001));
    resetCounts();

    await nginx.registerRoute(route(3002));

    expect(await readFile(confPath(), "utf8")).toContain("127.0.0.1:3002");
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("rewrites only the files that differ", async () => {
    const nginx = provider();
    await nginx.registerRoute(route());
    await rm(statePath());
    resetCounts();

    await nginx.registerRoute(route());

    expect(writes.mock.calls.map(([path]) => path.split(".tmp-")[0])).toEqual([statePath()]);
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("rewrites a file whose content matches but whose mode does not", async () => {
    const nginx = provider();
    await nginx.registerRoute(route());
    await chmod(confPath(), 0o644);
    resetCounts();

    await nginx.registerRoute(route());

    expect((await stat(confPath())).mode & 0o777).toBe(0o600);
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("replaces a symlink even when it resolves to the same content", async () => {
    const nginx = provider();
    await nginx.registerRoute(route());
    const elsewhere = join(root, "elsewhere.conf");
    await writeFile(elsewhere, await readFile(confPath(), "utf8"), { mode: 0o600 });
    await rm(confPath());
    await symlink(elsewhere, confPath());
    resetCounts();

    await nginx.registerRoute(route());

    expect((await lstat(confPath())).isFile()).toBe(true);
    // The link is snapshotted with `readlink` (an exec) so a rollback can restore it.
    expect(reloads.mock.calls.filter(([command]) => !command.startsWith("readlink"))).toHaveLength(
      1,
    );
  });

  it.each(["vhost", "sidecar"])(
    "replaces a dangling %s symlink instead of failing",
    async (which) => {
      const nginx = provider();
      await nginx.registerRoute(route());
      const path = which === "vhost" ? confPath() : statePath();
      await rm(path);
      await symlink(join(root, "missing-target"), path);
      resetCounts();

      await nginx.registerRoute(route());

      expect((await lstat(path)).isFile()).toBe(true);
      expect(
        reloads.mock.calls.filter(([command]) => !command.startsWith("readlink")),
      ).toHaveLength(1);
    },
  );

  it("does not trust the disk after another writer changed it and failed to restore it", async () => {
    const { rename } = await import("node:fs/promises");
    const nginx = provider();
    await nginx.registerRoute(route());
    await writeFile(join(root, "nginx.conf"), "events {}\nhttp {\n}\n");
    // Rate-limit publication: the snippet lands, the transport drops before any reload,
    // and every restore is refused. No reload ran, so only the write itself can tell
    // the provider that disk and the running edge may now differ.
    let published = false;
    const publish = vi.spyOn(executor, "rename").mockImplementation(async (from, to) => {
      if (published) throw new Error("restore denied");
      await rename(from, to);
      if (to.includes("rate")) {
        published = true;
        throw new Error("transport lost");
      }
    });
    await expect(nginx.applyRateLimit({ rps: 10, burst: 20, whitelist: [] })).rejects.toThrow();
    expect(published).toBe(true);
    publish.mockRestore();
    resetCounts();

    await nginx.registerRoute(route());

    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("trusts the disk again once the rollback after a failed reload has been reloaded", async () => {
    const nginx = provider();
    await nginx.registerRoute(route(3001));
    reloads.mockRejectedValueOnce(new Error("nginx: [emerg] simulated"));
    await expect(nginx.registerRoute(route(3002))).rejects.toThrow("simulated");
    // Rolled back to 3001 and reloaded.
    expect(await readFile(confPath(), "utf8")).toContain("127.0.0.1:3001");
    resetCounts();

    // The rollback reload succeeded, so the edge is known to run what is on disk.
    await nginx.registerRoute(route(3001));
    expect(reloads).not.toHaveBeenCalled();
  });

  it("leaves files it never attempted alone when an earlier write fails", async () => {
    const nginx = provider();
    await nginx.registerRoute(route(3001));
    const sidecarBefore = await readFile(statePath(), "utf8");
    writes.mockRejectedValueOnce(new Error("disk full"));
    resetCounts();

    await expect(nginx.registerRoute(route(3002))).rejects.toThrow("disk full");

    // The vhost write failed first; the sidecar was never written, so it is not restored.
    expect(writes.mock.calls.filter(([path]) => path.startsWith(statePath()))).toEqual([]);
    expect(await readFile(statePath(), "utf8")).toBe(sidecarBefore);
  });

  it("does not trust the disk after a failed rollback reload", async () => {
    const nginx = provider();
    await nginx.registerRoute(route(3001));
    reloads
      .mockRejectedValueOnce(new Error("nginx: [emerg] simulated"))
      .mockRejectedValueOnce(new Error("edge unreachable"));
    await expect(nginx.registerRoute(route(3002))).rejects.toThrow(/rollback failed/);
    resetCounts();

    await nginx.registerRoute(route(3001));

    expect(writes).not.toHaveBeenCalled();
    expect(reloads).toHaveBeenCalledTimes(1);
  });
});

describe("state outside the route files", () => {
  it("a restarted API (a new provider) syncs a changed trusted-proxy list", async () => {
    // The include comes from the API's environment, which changes only with a restart.
    await provider().registerRoute(route());
    vi.stubEnv("OPENSHIP_EDGE_TRUSTED_PROXIES", "10.20.0.0/16");
    resetCounts();

    await provider().registerRoute(route());

    expect(await readFile(join(sites, EDGE_CONTAINER_REAL_IP_CONF_NAME), "utf8")).toContain(
      "10.20.0.0/16",
    );
    expect(reloads).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it("serveEdgeChallenge confirms with a reload on a new provider, then skips", async () => {
    await provider().serveEdgeChallenge({ host: "203.0.113.10" });
    resetCounts();

    const next = provider();
    await next.serveEdgeChallenge({ host: "203.0.113.10" });
    expect(writes).not.toHaveBeenCalled();
    expect(reloads).toHaveBeenCalledTimes(1);

    await next.serveEdgeChallenge({ host: "203.0.113.10", tokens: ["tok-abcdef123456"] });
    // The token is written, but it is served, not loaded: no reload.
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("serveEdgeChallenge rewrites its vhost when only the mode is wrong", async () => {
    const nginx = provider();
    await nginx.serveEdgeChallenge({ host: "203.0.113.10" });
    const vhost = join(sites, "_oblien-challenge-203-0-113-10.conf");
    await chmod(vhost, 0o644);
    resetCounts();

    await nginx.serveEdgeChallenge({ host: "203.0.113.10" });

    expect((await stat(vhost)).mode & 0o777).toBe(0o600);
  });
});

describe("writers outside the config lock", () => {
  it("a reload that overlapped a certbot run does not vouch for what certbot wrote", async () => {
    const nginx = provider();
    await nginx.registerRoute(route(3001));
    let finishCertbot!: () => void;
    const certbotDone = new Promise<void>((resolve) => (finishCertbot = resolve));
    reloads.mockImplementation(async (command) => {
      if (command.includes("certbot")) await certbotDone;
      return "";
    });

    // certbot runs without the lock (issuance, renewal). Another route reloads meanwhile.
    const certbot = (
      nginx as unknown as { _execCertbot(args: string[]): Promise<string> }
    )._execCertbot(["renew"]);
    await nginx.registerRoute(route(3002));
    finishCertbot();
    await certbot;
    resetCounts();

    await nginx.registerRoute(route(3002));

    expect(reloads.mock.calls.filter(([command]) => !command.includes("certbot"))).toHaveLength(1);
  });
});

describe("certificate activation", () => {
  it("always reloads on activateCert, which installs material at unchanged paths", async () => {
    await installCert();
    const nginx = provider();
    await nginx.registerRoute({ ...route(), tls: true });
    resetCounts();

    await nginx.activateCert(DOMAIN);

    expect(writes).not.toHaveBeenCalled();
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("reusing an existing verified certificate on deploy adds no write or reload", async () => {
    await installCert();
    const nginx = provider();
    await nginx.registerRoute({ ...route(), tls: true });
    expect(await readFile(confPath(), "utf8")).toContain("listen 443 ssl");
    resetCounts();

    const result = await nginx.provisionCert(DOMAIN);

    expect(result.verified).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(reloads).not.toHaveBeenCalled();
  });

  it("an unchanged deploy of TLS routes costs one reload in total", async () => {
    await installCert();
    await provider().registerRoute({ ...route(), tls: true });
    resetCounts();

    // registerResolvedRoutes: registerRoute, then provisionCert for each hostname.
    const next = provider();
    await next.registerRoute({ ...route(), tls: true });
    await next.provisionCert(DOMAIN);

    expect(writes).not.toHaveBeenCalled();
    expect(reloads).toHaveBeenCalledTimes(1);
  });
});
