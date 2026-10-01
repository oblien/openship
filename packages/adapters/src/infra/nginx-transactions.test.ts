import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NginxProvider } from "./nginx";
import { LocalExecutor } from "../system/local-executor";
import { rootChecked } from "../system/privilege";
import {
  EDGE_CHALLENGE_URL_PREFIX,
  OPENRESTY_DEFAULT_PATHS,
  edgeChallengeVhostConf,
} from "./openresty-lua";

// Real file operations and atomic renames; only the proxy process is simulated.
const DOTTED = "staging.app.example.com";
const DASHED = "staging-app.example.com";
const TOKEN = "tok-abcdef123456";
const route = (domain: string, port = 3001) => ({
  domain,
  tls: false,
  targetUrl: `http://127.0.0.1:${port}`,
});
let root: string;
let sites: string;
let challenge: string;
let routePath: string;
let statePath: string;
let executor: LocalExecutor;
let nginx: NginxProvider;
let reload: MockInstance<LocalExecutor["exec"]>;

function provider() {
  return new NginxProvider({
    paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir: sites },
    certDir: join(root, "certs", "live"),
    challengeDir: join(root, "tokens"),
    executor: rootChecked(executor, "test: temporary filesystem with a simulated proxy"),
    pinPaths: true,
    containerEdge: true,
  });
}

function suffixedChallenge(host: string) {
  const suffix = createHash("sha1").update(host).digest("hex").slice(0, 8);
  return join(sites, `_oblien-challenge-staging-app-example-com-${suffix}.conf`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-edge-transaction-"));
  sites = join(root, "sites-enabled");
  await mkdir(sites);
  challenge = join(sites, "_oblien-challenge-staging-app-example-com.conf");
  routePath = join(sites, "staging-app-example-com.conf");
  statePath = join(sites, "staging-app-example-com.route.json");
  executor = new LocalExecutor();
  reload = vi.spyOn(executor, "exec").mockResolvedValue("");
  nginx = provider();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("challenge ownership", () => {
  it("retires the same host's challenge with one reload and retains its tokens", async () => {
    await nginx.serveEdgeChallenge({ host: DOTTED, tokens: [TOKEN] });
    reload.mockClear();
    await nginx.registerRoute(route(DOTTED));
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(readFile(challenge, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "tokens", TOKEN), "utf8")).toBe(TOKEN);
    expect(await readFile(routePath, "utf8")).toContain(
      `location ^~ ${EDGE_CHALLENGE_URL_PREFIX} {`,
    );
    reload.mockClear();
    await nginx.serveEdgeChallenge({ host: DOTTED });
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["registration", "readiness"])(
    "%s preserves a colliding hostname's verification",
    async (operation) => {
      if (operation === "readiness") await nginx.registerRoute(route(DASHED));
      await nginx.serveEdgeChallenge({ host: DOTTED, tokens: [TOKEN] });
      const before = await readFile(challenge, "utf8");
      if (operation === "registration") await nginx.registerRoute(route(DASHED));
      else await nginx.serveEdgeChallenge({ host: DASHED });
      expect(await readFile(challenge, "utf8")).toBe(before);
      expect(await readFile(join(root, "tokens", TOKEN), "utf8")).toBe(TOKEN);
    },
  );

  it("allocates distinct challenge files concurrently and keeps the suffix after the base is freed", async () => {
    await Promise.all([
      nginx.serveEdgeChallenge({ host: DOTTED }),
      provider().serveEdgeChallenge({ host: DASHED }),
    ]);
    expect(await readFile(challenge, "utf8")).toBe(edgeChallengeVhostConf(DOTTED));
    expect(await readFile(suffixedChallenge(DASHED), "utf8")).toBe(edgeChallengeVhostConf(DASHED));
    await nginx.registerRoute(route(DOTTED));
    await nginx.serveEdgeChallenge({ host: DASHED });
    await expect(readFile(challenge)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(suffixedChallenge(DASHED), "utf8")).toBe(edgeChallengeVhostConf(DASHED));
  });

  it.each(["registration", "readiness"])(
    "%s removes both legacy duplicates owned by the host",
    async (operation) => {
      if (operation === "readiness") await nginx.registerRoute(route(DOTTED));
      await writeFile(challenge, edgeChallengeVhostConf(DOTTED));
      await writeFile(suffixedChallenge(DOTTED), edgeChallengeVhostConf(DOTTED));
      reload.mockClear();
      if (operation === "registration") await nginx.registerRoute(route(DOTTED));
      else await nginx.serveEdgeChallenge({ host: DOTTED });
      expect(
        (await readdir(sites)).filter((file) => file.startsWith("_oblien-challenge-")),
      ).toEqual([]);
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat a commented server_name as ownership", async () => {
    const conf = edgeChallengeVhostConf(DASHED).replace(
      "server_name",
      `# server_name ${DOTTED};\n    server_name`,
    );
    await writeFile(challenge, conf);
    await nginx.registerRoute(route(DOTTED));
    expect(await readFile(challenge, "utf8")).toBe(conf);
  });

  it.each(
    [
      {
        kind: "multi-host",
        conf: edgeChallengeVhostConf(DOTTED).replace(
          `server_name ${DOTTED};`,
          `server_name ${DOTTED} ${DASHED};`,
        ),
      },
      {
        kind: "unmarked",
        conf: `server { listen 80; server_name ${DOTTED}; location / { return 200; } }`,
      },
    ].flatMap((entry) =>
      ["registration", "readiness", "challenge creation"].map((operation) => ({
        ...entry,
        operation,
      })),
    ),
  )("refuses $operation for a $kind config claiming the same host", async ({ conf, operation }) => {
    if (operation === "readiness") await nginx.registerRoute(route(DOTTED));
    await writeFile(challenge, conf);
    const beforeRoute = await readFile(routePath, "utf8").catch(() => null);
    reload.mockClear();
    await expect(
      operation === "registration"
        ? nginx.registerRoute(route(DOTTED))
        : nginx.serveEdgeChallenge({ host: DOTTED }),
    ).rejects.toThrow("claims this hostname");
    expect(await readFile(challenge, "utf8")).toBe(conf);
    expect(await readFile(routePath, "utf8").catch(() => null)).toBe(beforeRoute);
    expect(
      (await readdir(sites)).filter((name) => name.startsWith("_oblien-challenge-")),
    ).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses a foreign file even at the disambiguated name", async () => {
    const foreign = edgeChallengeVhostConf("someone-else.example.com");
    await writeFile(challenge, edgeChallengeVhostConf(DASHED));
    await writeFile(suffixedChallenge(DOTTED), foreign);
    await expect(nginx.serveEdgeChallenge({ host: DOTTED })).rejects.toThrow("another hostname");
    expect(await readFile(suffixedChallenge(DOTTED), "utf8")).toBe(foreign);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("configuration transactions", () => {
  it.each(["route-write", "state-write", "remove-before", "remove-after", "reload"])(
    "restores the route, state and challenge on %s failure",
    async (failure) => {
      await nginx.registerRoute(route(DOTTED));
      await writeFile(challenge, edgeChallengeVhostConf(DOTTED));
      const beforeRoute = await readFile(routePath, "utf8");
      const beforeState = await readFile(statePath, "utf8");
      const beforeChallenge = await readFile(challenge, "utf8");
      const sibling = join(sites, "unrelated.conf");
      await writeFile(sibling, "server { listen 80; server_name unrelated.example.com; }");
      const siblingBefore = await readFile(sibling, "utf8");
      let failed = false;
      const rename = executor.rename.bind(executor);
      vi.spyOn(executor, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (
          !failed &&
          ((failure === "route-write" && to === routePath) ||
            (failure === "state-write" && to === statePath))
        ) {
          failed = true;
          throw new Error("injected file failure");
        }
      });
      const remove = executor.rm.bind(executor);
      vi.spyOn(executor, "rm").mockImplementation(async (path) => {
        if (!failed && path === challenge && failure.startsWith("remove-")) {
          failed = true;
          if (failure === "remove-after") await remove(path);
          throw new Error("injected file failure");
        }
        return remove(path);
      });
      if (failure === "reload") reload.mockRejectedValueOnce(new Error("injected reload failure"));
      await expect(nginx.registerRoute(route(DOTTED, 3002))).rejects.toThrow("injected");
      expect(await readFile(routePath, "utf8")).toBe(beforeRoute);
      expect(await readFile(statePath, "utf8")).toBe(beforeState);
      expect(await readFile(challenge, "utf8")).toBe(beforeChallenge);
      expect(await readFile(sibling, "utf8")).toBe(siblingBefore);
      expect((await readdir(sites)).some((name) => name.includes(".tmp-"))).toBe(false);
    },
  );

  it("removes a failed first route and restores the challenge", async () => {
    await nginx.serveEdgeChallenge({ host: DOTTED, tokens: [TOKEN] });
    reload.mockRejectedValueOnce(new Error("invalid configuration"));
    await expect(nginx.registerRoute(route(DOTTED))).rejects.toThrow("invalid configuration");
    await expect(readFile(routePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(challenge, "utf8")).toBe(edgeChallengeVhostConf(DOTTED));
    expect(await readFile(join(root, "tokens", TOKEN), "utf8")).toBe(TOKEN);
  });

  it("reports a rollback failure, restores the other files and does not reload a partial restore", async () => {
    await nginx.registerRoute(route(DOTTED));
    await writeFile(challenge, edgeChallengeVhostConf(DOTTED));
    const rename = executor.rename.bind(executor);
    let routeWrites = 0;
    vi.spyOn(executor, "rename").mockImplementation(async (from, to) => {
      if (to === routePath && ++routeWrites === 2) throw new Error("restore denied");
      return rename(from, to);
    });
    reload.mockClear().mockRejectedValueOnce(new Error("reload failed"));
    await expect(nginx.registerRoute(route(DOTTED, 3002))).rejects.toThrow(
      /rollback failed:.*restore denied/,
    );
    expect(await readFile(challenge, "utf8")).toBe(edgeChallengeVhostConf(DOTTED));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(route(DOTTED));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("serializes different provider instances so a late rollback cannot erase a later update", async () => {
    await nginx.registerRoute(route(DOTTED));
    await writeFile(challenge, edgeChallengeVhostConf(DOTTED));
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reloading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    reload.mockImplementationOnce(async () => {
      entered();
      await pending;
      throw new Error("first reload failed");
    });
    const first = nginx.registerRoute(route(DOTTED, 3002));
    const firstResult = expect(first).rejects.toThrow("first reload failed");
    await reloading;
    const second = provider().registerRoute(route(DOTTED, 3003));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await readFile(routePath, "utf8")).toContain("127.0.0.1:3002");
    release();
    await Promise.all([firstResult, second]);
    expect(await readFile(routePath, "utf8")).toContain("127.0.0.1:3003");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(route(DOTTED, 3003));
    await expect(readFile(challenge)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
