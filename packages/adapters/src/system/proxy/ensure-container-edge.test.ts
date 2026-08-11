import { describe, expect, it, vi } from "vitest";

import { buildEdgeRunCommand, ensureContainerEdge, resolveEdgeImage } from "./ensure-container-edge";
import type { CommandExecutor } from "../../types";

const IMAGE = "ghcr.io/oblien/openship-edge:1.2.3";

interface BoxOpts {
  /** A running edge container already present. */
  edgeContainer?: string;
  /** Image ref that running container was created from. */
  edgeContainerImage?: string;
  /** What the carried-vhost sanitize pass reports back. */
  sanitizeOutput?: string;
  /** `ls -1` of sites-enabled before the carry / after it. */
  beforeCarry?: string;
  afterCarry?: string;
  /** Our BARE host OpenResty is what's serving (ourLuaOnHost → true). */
  bareIsOurs?: boolean;
  dockerMissing?: boolean;
  pullFails?: boolean;
  runFails?: boolean;
  configInvalid?: boolean;
  /** Container starts and validates, but nothing ever binds :80. */
  notListening?: boolean;
}

/**
 * Records every command so a test can assert on ORDER, not just occurrence.
 *
 * The procfs socket table is STATEFUL — :80 only answers once the container has
 * started, which is both physically true and necessary here: `probeEdge` and
 * `waitForPortListening` fall back to the identical `cat /proc/net/tcp` command, so
 * a box that reported :80 busy from the start would look like a foreign proxy and
 * be refused by the consent gate before anything else ran.
 */
function box(opts: BoxOpts = {}) {
  const commands: string[] = [];
  let containerStarted = false;
  let carried = false;
  const answer = async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.startsWith("docker ps --filter name=openship-edge")) return opts.edgeContainer ?? "";
    if (cmd.startsWith("docker ps --format")) return "";
    if (cmd.startsWith("docker inspect")) return opts.edgeContainerImage ?? "";
    if (cmd.startsWith("docker version")) return opts.dockerMissing ? "" : "27.0.0";
    if (cmd.includes("site_logger.lua")) return opts.bareIsOurs ? "ok" : "";
    // The carried-vhost sanitize pass (one shell loop over sites-enabled).
    if (cmd.includes("dropped-catchall")) return opts.sanitizeOutput ?? "";
    // Directory listing: before the carry vs after (the rollback diff).
    if (cmd.startsWith("ls -1")) {
      const listed = carried ? (opts.afterCarry ?? "") : (opts.beforeCarry ?? "");
      carried = true;
      return listed;
    }
    if (cmd.includes("openresty -t")) {
      if (opts.configInvalid) throw new Error("nginx: [emerg] invalid config");
      return "syntax is ok";
    }
    if (cmd.includes("openresty -v")) return "openresty/1.27.1.1";
    // probeEdge's own probe (`ss`): only a bare-OURS box has a host listener, and
    // it has to resolve to OpenResty or the edge reads as foreign and the consent
    // gate refuses before we get anywhere.
    if (opts.bareIsOurs) {
      if (cmd.includes("sport = :80")) {
        return 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=555,fd=6))';
      }
      if (cmd.includes("sport = :443")) {
        return 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=555,fd=8))';
      }
      if (cmd.includes("-p 555 -o args=")) {
        return "nginx: master process /usr/local/openresty/nginx/sbin/nginx";
      }
    }
    // procfs socket table: state 0A = LISTEN, hex port 0050 = 80.
    if (cmd.includes("/proc/net/tcp")) {
      return containerStarted && !opts.notListening
        ? "  0: 00000000:0050 00000000:0000 0A 00000000:00000000"
        : "";
    }
    return "";
  };

  const executor = {
    exec: vi.fn(answer),
    streamExec: vi.fn(async (cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith("docker pull")) return { code: opts.pullFails ? 1 : 0, output: "" };
      if (cmd.startsWith("docker run")) {
        if (opts.runFails) return { code: 1, output: "" };
        containerStarted = true;
        return { code: 0, output: "" };
      }
      return { code: 0, output: "" };
    }),
    exists: vi.fn(async () => true),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  } as unknown as CommandExecutor;

  return { executor, commands, onLog: vi.fn() };
}

const idx = (commands: string[], needle: string) =>
  commands.findIndex((c) => c.includes(needle));

describe("resolveEdgeImage", () => {
  it("prefers the caller's pinned ref over env", () => {
    expect(resolveEdgeImage(IMAGE)).toBe(IMAGE);
  });

  it("falls back to registry + version", () => {
    const prev = { ...process.env };
    process.env.OPENSHIP_IMAGE_REGISTRY = "docker.io/oblien";
    process.env.OPENSHIP_VERSION = "9.9.9";
    delete process.env.OPENSHIP_EDGE_IMAGE;
    expect(resolveEdgeImage()).toBe("docker.io/oblien/openship-edge:9.9.9");
    process.env = prev;
  });
});

describe("buildEdgeRunCommand", () => {
  it("runs host-networked with the four state mounts", () => {
    const cmd = buildEdgeRunCommand("openship-edge", IMAGE);
    // Host networking is what lets it own :80/:443 and reach apps on loopback.
    expect(cmd).toContain("--network host");
    expect(cmd).toContain("--restart unless-stopped");
    expect(cmd).toContain("'/var/lib/openship/edge/sites-enabled:/usr/local/openresty/nginx/conf/sites-enabled:z'");
    expect(cmd).toContain("'/etc/letsencrypt:/etc/letsencrypt:z'");
    expect(cmd).toContain("'/var/lib/openship/edge/acme:/var/www/acme:z'");
    expect(cmd).toContain("'/opt/openship/static:/opt/openship/static:z'");
  });
});

describe("ensureContainerEdge", () => {
  it("is a no-op when our edge is already running the pinned image", async () => {
    const { executor, commands, onLog } = box({
      edgeContainer: "openship-edge",
      edgeContainerImage: IMAGE,
    });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE });

    expect(result).toEqual({ container: "openship-edge", image: IMAGE, converted: false });
    expect(commands.some((c) => c.startsWith("docker pull"))).toBe(false);
  });

  it("updates a running edge that's on an older image", async () => {
    // The edge's Lua + nginx.conf are baked in, so an edge stuck on an old tag serves
    // rules a newer API believes it rewrote. Upgrading the API upgrades the edge.
    const { executor, commands, onLog } = box({
      edgeContainer: "openship-edge",
      edgeContainerImage: "ghcr.io/oblien/openship-edge:1.0.0",
    });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    expect(result.updated).toBe(true);
    // Pull before the old one is removed, same rule as the bare conversion.
    expect(idx(commands, "docker pull")).toBeLessThan(idx(commands, "docker rm -f"));
    expect(commands.some((c) => c.includes(`docker run -d --name 'openship-edge'`))).toBe(true);
  });

  // The bare→container conversion used to `cp -a` the host edge's confs verbatim.
  // Our own bare catch-all declares `listen 80 default_server`, and the image's
  // nginx.conf declares one too — so the container died with `[emerg] a duplicate
  // default server` and the box was rolled back to the edge it was leaving.
  it("sanitizes the mounted vhost dir on EVERY start, not just after a carry", async () => {
    // No carry at all (no bare edge): the dir is still host state that can hold a
    // conf from an older version, so a plain install must clean it too.
    const { executor, commands, onLog } = box({ sanitizeOutput: "" });
    await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });
    expect(idx(commands, "dropped-catchall")).toBeGreaterThanOrEqual(0);
    expect(idx(commands, "dropped-catchall")).toBeLessThan(idx(commands, "docker run"));
  });

  it("sanitizes carried vhosts before the container starts, and says what it changed", async () => {
    const { executor, commands, onLog } = box({
      bareIsOurs: true,
      sanitizeOutput: "dropped-catchall /var/lib/openship/edge/sites-enabled/default.conf",
    });

    await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    // After the carry, before `docker run` — a sanitize that lands after the start
    // is a sanitize that never prevented the crash.
    expect(idx(commands, "cp -a")).toBeLessThan(idx(commands, "dropped-catchall"));
    expect(idx(commands, "dropped-catchall")).toBeLessThan(idx(commands, "docker run"));
    const said = onLog.mock.calls.map(([l]) => l.message).join("\n");
    expect(said).toMatch(/Dropped catch-all vhost .*default\.conf/);
  });

  // A failed conversion used to leave the carried confs in the host bind mount, so
  // EVERY later edge start on that box — including the compose stack's own `edge`
  // service — died on the same bad conf, with the original failure long gone.
  it("removes the carried vhosts when the conversion rolls back", async () => {
    const { executor, commands, onLog } = box({
      bareIsOurs: true,
      runFails: true,
      beforeCarry: "openship-existing.conf",
      afterCarry: "openship-existing.conf\ndefault.conf\nlegacy.conf",
    });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow();

    const rm = commands.find((c) => c.startsWith("rm -f"));
    expect(rm).toContain("default.conf");
    expect(rm).toContain("legacy.conf");
    // The conf that was already there is NOT ours to delete.
    expect(rm).not.toContain("openship-existing.conf");
    // And the bare edge is put back after the dir is clean, not before.
    expect(idx(commands, "rm -f")).toBeLessThan(idx(commands, "systemctl enable --now openresty"));
  });

  it("leaves the running edge alone when the new image can't be pulled", async () => {
    const { executor, commands, onLog } = box({
      edgeContainer: "openship-edge",
      edgeContainerImage: "ghcr.io/oblien/openship-edge:1.0.0",
      pullFails: true,
    });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE });

    expect(result.updated).toBe(false);
    expect(commands.some((c) => c.startsWith("docker rm -f"))).toBe(false);
  });

  it("puts the OLD image back when the new one won't come up", async () => {
    const { executor, commands, onLog } = box({
      edgeContainer: "openship-edge",
      edgeContainerImage: "ghcr.io/oblien/openship-edge:1.0.0",
      runFails: true,
    });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    expect(result.updated).toBe(false);
    const runs = commands.filter((c) => c.startsWith("docker run -d"));
    expect(runs.at(-1)).toContain("openship-edge:1.0.0");
  });

  it("installs onto a box with no edge at all", async () => {
    const { executor, commands, onLog } = box();
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE });

    expect(result.converted).toBe(false);
    expect(commands.some((c) => c === `docker pull '${IMAGE}'`)).toBe(true);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(true);
    // Nothing to stop: never touch the openresty unit on a box that wasn't ours.
    expect(commands.some((c) => c.includes("systemctl disable --now openresty"))).toBe(false);
  });

  it("converts a bare host edge, and pulls BEFORE stopping it", async () => {
    const { executor, commands, onLog } = box({ bareIsOurs: true });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE });

    expect(result.converted).toBe(true);
    // The ordering is the safety property: a registry failure must not be able to
    // leave a live box with its proxy stopped and no container to replace it.
    expect(idx(commands, "docker pull")).toBeGreaterThanOrEqual(0);
    expect(idx(commands, "docker pull")).toBeLessThan(idx(commands, "systemctl disable --now openresty"));
    // Vhosts carried across before the cutover, so served domains survive.
    expect(idx(commands, "cp -a")).toBeLessThan(idx(commands, "systemctl disable --now openresty"));
  });

  it("aborts on a failed pull with the bare edge untouched", async () => {
    const { executor, commands, onLog } = box({ bareIsOurs: true, pullFails: true });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow(
      /Could not pull the edge image/,
    );
    expect(commands.some((c) => c.includes("systemctl disable --now openresty"))).toBe(false);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(false);
  });

  it("rolls back to the host OpenResty when the container won't start", async () => {
    // This is the failure the auto-migrate-on-deploy path has to survive: the box was
    // serving before we touched it, so it must be serving after we fail.
    const { executor, commands, onLog } = box({ bareIsOurs: true, runFails: true });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow(
      /Edge container setup failed/,
    );
    expect(commands.some((c) => c.startsWith("docker rm -f"))).toBe(true);
    expect(commands.some((c) => c.includes("systemctl enable --now openresty"))).toBe(true);
  });

  it("rolls back when the container starts but its config is invalid", async () => {
    const { executor, commands, onLog } = box({ bareIsOurs: true, configInvalid: true });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow(
      /Edge container setup failed/,
    );
    expect(commands.some((c) => c.includes("systemctl enable --now openresty"))).toBe(true);
  });

  it("rolls back when the container is up but nothing is listening on :80", async () => {
    // `docker run` exiting 0 proves only that the daemon accepted it — a container
    // that starts and immediately dies would otherwise read as a success.
    const { executor, commands, onLog } = box({ bareIsOurs: true, notListening: true });

    await expect(
      ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 }),
    ).rejects.toThrow(/nothing is listening on :80/);
    expect(commands.some((c) => c.includes("systemctl enable --now openresty"))).toBe(true);
  });

  it("does not pretend to restore a bare edge that was never ours", async () => {
    const { executor, commands, onLog } = box({ runFails: true });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow();
    expect(commands.some((c) => c.includes("systemctl enable --now openresty"))).toBe(false);
  });

  it("refuses with an actionable message when Docker is missing", async () => {
    const { executor, onLog } = box({ dockerMissing: true });
    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow(
      /Docker isn't available/,
    );
  });
});
