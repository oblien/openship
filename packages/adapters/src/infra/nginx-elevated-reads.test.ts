import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NginxProvider } from "./nginx";
import { LocalExecutor } from "../system/local-executor";
import { elevatedExecutor } from "../system/elevated-executor";
import { rootChecked } from "../system/privilege";
import { sq } from "../system/local-shell";
import { OPENRESTY_DEFAULT_PATHS } from "./openresty-lua";
import type { CommandExecutor } from "../types";

/**
 * A non-root SSH login on a box whose vhosts are root:root 0600: the unelevated read is
 * refused, so every read of an edge file goes through `sudo cat` and `exec`, which trims
 * its output. Elevated commands run here without sudo; everything else (the reload) is
 * only recorded.
 */
let root: string;
let sites: string;
let local: LocalExecutor;
let reloads: string[];
let writes: string[];
let fakeBin: string;

function deniedReadsExecutor(): CommandExecutor {
  const run = local.exec.bind(local);
  const login = Object.create(local) as CommandExecutor;
  login.readFile = async (path: string) => {
    if (path.startsWith(sites)) throw new Error(`EACCES: permission denied, open '${path}'`);
    return local.readFile(path);
  };
  login.writeFile = async (path: string, content: string, opts?: { mode?: number }) => {
    writes.push(path);
    return local.writeFile(path, content, opts);
  };
  login.exec = async (command: string, opts?: { timeout?: number }) => {
    if (command.includes("openresty")) {
      reloads.push(command);
      return "";
    }
    // Run the elevated payload unprivileged; a no-op chown stands in for root's.
    if (command.startsWith("sudo -n ")) {
      return run(`PATH=${sq(fakeBin)}:"$PATH" ${command.slice("sudo -n ".length)}`, opts);
    }
    return run(command, opts);
  };
  return login;
}

function provider() {
  return new NginxProvider({
    paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir: sites },
    certDir: join(root, "certs", "live"),
    challengeDir: join(root, "tokens"),
    executor: rootChecked(
      elevatedExecutor(deniedReadsExecutor()),
      "test: temporary filesystem behind a refused unelevated read",
    ),
    pinPaths: true,
    containerEdge: true,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-edge-elevated-"));
  sites = join(root, "sites-enabled");
  await mkdir(sites);
  fakeBin = join(root, "bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  local = new LocalExecutor();
  reloads = [];
  writes = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("edge files read through sudo", () => {
  it("lets serveEdgeChallenge recognise its own unchanged vhost and skip the write and reload", async () => {
    const nginx = provider();
    await nginx.serveEdgeChallenge({ host: "app.example.com" });
    const vhost = await readFile(join(sites, "_oblien-challenge-app-example-com.conf"), "utf8");
    expect(vhost.endsWith("\n")).toBe(true);
    expect(reloads.length).toBeGreaterThan(0);

    reloads = [];
    writes = [];
    await nginx.serveEdgeChallenge({ host: "app.example.com" });

    // Before byte-exact reads the trimmed snapshot never matched, so this rewrote and
    // reloaded on every call.
    expect(writes).toEqual([]);
    expect(reloads).toEqual([]);
  });
});
