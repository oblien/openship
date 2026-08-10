import { describe, expect, it, vi } from "vitest";

import {
  buildEdgeRunCommand,
  ensureContainerEdge,
  resolveEdgeImage,
} from "./ensure-container-edge";
import { setManagedImagesFromSource } from "../managed-image";
import { JOURNAL_PATH } from "./takeover-journal";
import type { CommandExecutor } from "../../types";
import type { InstallerConfig } from "../types";

const IMAGE = "ghcr.io/oblien/openship-edge:1.2.3";

/**
 * A pre-accepted takeover — the non-interactive equivalent of the operator
 * pressing "Stop it & take over". `stopTargets: []` on purpose: an empty list
 * falls back to `stopTargetsForStatus(status)`, so these tests exercise the stop
 * the PROBE derived (the openresty unit) rather than one the test handed in.
 */
const TAKEOVER: InstallerConfig = { edgePolicy: { mode: "takeover", stopTargets: [] } };

interface BoxOpts {
  /** An edge container already present. */
  edgeContainer?: string;
  /** Image ref that container was created from. */
  edgeContainerImage?: string;
  /** Its `.State.Status`. `restarting` is docker's word for a crash loop. */
  edgeStatus?: string;
  /** `docker logs` for our edge container. */
  crashLog?: string;
  /** What the vhost sanitize pass reports back. */
  sanitizeOutput?: string;
  /**
   * A DEPRECATED BARE HOST OpenResty owns 80/443 — a proxy to MIGRATE FROM, which
   * is the only thing it is now: the edge is a container, so a host OpenResty is
   * foreign exactly like a distro nginx or a Caddy.
   */
  hostOpenResty?: boolean;
  /** Something ELSE keeps :80 bound after the owner is stopped. */
  portStaysBound?: boolean;
  dockerMissing?: boolean;
  pullFails?: boolean;
  runFails?: boolean;
  configInvalid?: boolean;
  /** Container starts and validates, but nothing ever binds :80. */
  notListening?: boolean;
  /**
   * The target image ref is ALREADY in the executor's local store — the delivered
   * dev tag (`deliverManagedImage` built it on the control plane and shipped it here).
   * Flips the pull gate: present ⇒ no pull, absent (prod) ⇒ pull.
   */
  imagePresent?: boolean;
}

/** procfs socket table rows: state 0A = LISTEN, hex 0050 = 80, 01BB = 443. */
const PROC_LISTENING = [
  "  0: 00000000:0050 00000000:0000 0A 00000000:00000000 0 0 1 1 0",
  "  1: 00000000:01BB 00000000:0000 0A 00000000:00000000 0 0 1 2 0",
].join("\n");

/**
 * Records every command so a test can assert on ORDER, not just occurrence.
 *
 * The box is a STATE MACHINE, not a lookup table, because every property under
 * test is about ordering: who holds :80 changes as the host unit is stopped and
 * the container is started, and both `probeEdge` and `waitForPortFree` read the
 * same socket table. A fixture that answered statically would either look like a
 * foreign proxy forever (nothing can ever be taken over) or like a free box
 * forever (the takeover is never proven).
 *
 * Three pieces of state:
 *   - `edgeState`  — our container's `.State.Status` (`docker run` → running,
 *     `docker rm -f` / `docker stop` → gone). This is the ONLY signal that tells
 *     a crash loop from a healthy edge.
 *   - `unitUp`     — the host openresty.service (`disable --now` → down,
 *     `enable --now` / `start` → back up, i.e. a rollback).
 *   - `files`      — a real filesystem for the takeover journal, so
 *     write → read → rollback → clear round-trips instead of silently no-opping.
 */
function box(opts: BoxOpts = {}) {
  const commands: string[] = [];
  const files = new Map<string, string>();
  let edgeState = opts.edgeStatus ?? (opts.edgeContainer ? "running" : "");
  let unitUp = Boolean(opts.hostOpenResty);
  // The local image ID the target ref resolves to — non-empty iff the image is
  // already on the box (a delivered dev tag). `imageExistsLocally` reads this: empty
  // (prod) ⇒ pull, present (dev, shipped by deliverManagedImage) ⇒ skip the pull.
  const localImageId = opts.imagePresent ? "sha-present" : "";

  /** Is anything holding the edge ports right now? */
  const served = () =>
    (edgeState === "running" && !opts.notListening) || unitUp || Boolean(opts.portStaysBound);

  const answer = async (cmd: string): Promise<string> => {
    commands.push(cmd);

    if (cmd.startsWith("docker ps --filter name=openship-edge")) return opts.edgeContainer ?? "";
    if (cmd.startsWith("docker ps")) return "";
    if (cmd.startsWith("docker version")) return opts.dockerMissing ? "" : "27.0.0";
    if (cmd.includes("{{.State.Status}}")) return edgeState;
    // `containerState` asks for run state AND image in one inspect, TAB-separated —
    // answering with a bare image ref parses as `running:"<ref>", image:undefined`,
    // which reads as "no image" and silently skips the update branch.
    if (cmd.includes("{{.State.Running}}")) {
      return opts.edgeContainerImage ? `true\t${opts.edgeContainerImage}` : "";
    }
    // `imageExistsLocally` — `docker image inspect -f '{{.Id}}' <ref>`. Non-empty
    // means the ref is on the box. Must precede the generic inspect catch.
    if (cmd.includes("{{.Id}}")) return localImageId;
    if (cmd.startsWith("docker inspect")) return "";
    if (cmd.startsWith("docker logs")) return opts.crashLog ?? "";
    if (cmd.startsWith("docker rm -f") || cmd.startsWith("docker stop")) {
      edgeState = "";
      return "";
    }

    // The vhost sanitize pass (one shell loop over sites-enabled).
    if (cmd.includes("dropped-catchall")) return opts.sanitizeOutput ?? "";

    if (cmd.includes("openresty -t")) {
      if (opts.configInvalid) throw new Error("nginx: [emerg] invalid config");
      return "syntax is ok";
    }
    if (cmd.includes("openresty -v")) return "openresty/1.27.1.1";

    if (cmd.includes("is-enabled")) return "enabled";
    if (cmd.includes("disable --now")) {
      unitUp = false;
      return "";
    }
    if (cmd.includes("systemctl enable --now") || cmd.startsWith("systemctl start ")) {
      unitUp = true;
      return "";
    }

    // What `probeEdge` sees: the bare host OpenResty, resolved all the way to its
    // systemd unit. Without the cgroup→unit hop the stop target degrades to a raw
    // `kill`, which the master just respawns past.
    if (opts.hostOpenResty && unitUp) {
      if (cmd.includes("sport = :80")) {
        return 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=555,fd=6))';
      }
      if (cmd.includes("sport = :443")) {
        return 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=555,fd=8))';
      }
      if (cmd.includes("-p 555 -o args=")) {
        return "nginx: master process /usr/local/openresty/nginx/sbin/nginx";
      }
      if (cmd.includes("/proc/555/cgroup")) return "0::/system.slice/openresty.service";
      if (cmd.startsWith("systemctl show")) return "OpenResty";
    }

    // `portIsServed` (the rollback's proof) — matched BEFORE the raw socket table,
    // because its command contains both `ss -ltn` and a /proc/net/tcp grep.
    if (cmd.includes("ss -ltn")) return served() ? "yes" : "";
    if (cmd.includes("/proc/net/tcp")) return served() ? PROC_LISTENING : "";

    if (cmd.startsWith("cat ")) {
      const path = cmd.slice(4).split(/\s/)[0];
      if (files.has(path)) return files.get(path) as string;
    }
    if (cmd.startsWith("rm -f ")) {
      files.delete(cmd.slice(6).split(/\s/)[0]);
      return "";
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
        edgeState = "running";
        return { code: 0, output: "" };
      }
      return { code: 0, output: "" };
    }),
    // Every existence check (mount dirs, journal) is true so the takeover path is
    // unaffected — the retired build path was the only conditional probe.
    exists: vi.fn(async () => true),
    readFile: vi.fn(async () => ""),
    // Journal writes go through the executor, not a shell — recorded in `commands`
    // too so a test can assert the journal existed BEFORE the stop it undoes.
    writeFile: vi.fn(async (path: string, content: string) => {
      commands.push(`writeFile ${path}`);
      files.set(path, content);
    }),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  } as unknown as CommandExecutor;

  return { executor, commands, files, onLog: vi.fn() };
}

const idx = (commands: string[], needle: string) => commands.findIndex((c) => c.includes(needle));
const said = (onLog: { mock: { calls: unknown[][] } }) =>
  onLog.mock.calls.map(([l]) => (l as { message?: string })?.message ?? "").join("\n");

/** The stop freeEdgeTargets issues for the host unit — shell-quoted by `sq`. */
const STOP_UNIT = "disable --now 'openresty.service'";
/** The rollback's restore of that same unit. */
const RESTORE_UNIT = "enable --now 'openresty.service'";

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

  // Docker calls a crash loop "running": `.State.Running == true`, and it shows up in
  // plain `docker ps`, so `resolveOurEdgeContainer` finds it and this branch used to
  // return success. That is the whole "Fix edge" bug — the ONE code path that could
  // have resolved the crash loop (the consent gate, which stops whatever else holds
  // :80) was skipped because the flapper counted as "already installed", so every
  // press logged `edge installed successfully` and left "Edge down" on screen.
  it("REGRESSION: recreates a CRASH-LOOPING edge instead of reporting it installed", async () => {
    const { executor, commands, onLog } = box({
      edgeContainer: "openship-edge",
      edgeContainerImage: IMAGE,
      edgeStatus: "restarting",
      crashLog:
        "2026/08/04 12:00:00 [emerg] 1#1: bind() to 0.0.0.0:80 failed (98: Address already in use)",
      hostOpenResty: true,
    });

    const result = await ensureContainerEdge(executor, {
      onLog,
      image: IMAGE,
      config: TAKEOVER,
      verifyTimeoutMs: 50,
    });

    // It didn't return early, it MIGRATED: the host OpenResty that was holding :80
    // is what the crash loop was about, and it got stopped.
    expect(result.converted).toBe(true);
    expect(commands.some((c) => c.includes(STOP_UNIT))).toBe(true);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(true);
    // And it said the actionable thing, not "container is restarting".
    expect(said(onLog)).toMatch(/isn't serving.*Address already in use/);
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
    // Pull before the old one is removed, same rule as the migration path.
    expect(idx(commands, "docker pull")).toBeLessThan(idx(commands, "docker rm -f"));
    expect(commands.some((c) => c.includes(`docker run -d --name 'openship-edge'`))).toBe(true);
  });

  // The mounted vhost dir is HOST state that outlives every container. Our own
  // former bare edge declares `listen 80 default_server`, and the image's nginx.conf
  // declares one too — so a stale conf left there kills the container with
  // `[emerg] a duplicate default server` on EVERY later start, by anyone.
  it("sanitizes the mounted vhost dir on EVERY start, not just after a migration", async () => {
    // No migration at all (nothing owns the ports): the dir can still hold a conf
    // from an older version, so a plain install must clean it too.
    const { executor, commands, onLog } = box({ sanitizeOutput: "" });
    await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });
    expect(idx(commands, "dropped-catchall")).toBeGreaterThanOrEqual(0);
    expect(idx(commands, "dropped-catchall")).toBeLessThan(idx(commands, "docker run"));
  });

  it("sanitizes the dir it inherited from the old proxy, and says what it changed", async () => {
    const { executor, commands, onLog } = box({
      hostOpenResty: true,
      sanitizeOutput: "dropped-catchall /var/lib/openship/edge/sites-enabled/default.conf",
    });

    await ensureContainerEdge(executor, {
      onLog,
      image: IMAGE,
      config: TAKEOVER,
      verifyTimeoutMs: 50,
    });

    // After the old proxy is stopped, before `docker run` — a sanitize that lands
    // after the start is a sanitize that never prevented the crash.
    expect(idx(commands, STOP_UNIT)).toBeLessThan(idx(commands, "dropped-catchall"));
    expect(idx(commands, "dropped-catchall")).toBeLessThan(idx(commands, "docker run"));
    expect(said(onLog)).toMatch(/Dropped catch-all vhost .*default\.conf/);
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
    // Neither image came up, so the box has NO edge — and that has to be reported,
    // not just logged, or the worst outcome this function has is invisible.
    expect(result.edgeDown).toBe(true);
  });

  it("installs onto a box with no edge at all", async () => {
    const { executor, commands, onLog } = box();
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    expect(result.converted).toBe(false);
    expect(commands.some((c) => c === `docker pull '${IMAGE}'`)).toBe(true);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(true);
    // Nothing owned the ports: never stop a service, and never journal a rollback.
    expect(commands.some((c) => c.includes("systemctl disable --now"))).toBe(false);
    expect(commands.some((c) => c.startsWith("writeFile"))).toBe(false);
  });

  // A bare host OpenResty is DEPRECATED — including one an older Openship
  // apt-installed. It goes through the ordinary foreign-proxy gate (prompt, site
  // import, journaled stop) like a distro nginx, and there is deliberately no second
  // "decommission the legacy edge" path: a second path is exactly how the first one
  // got skipped.
  it("migrates a deprecated bare host OpenResty, and pulls BEFORE stopping it", async () => {
    const { executor, commands, onLog } = box({ hostOpenResty: true });
    const result = await ensureContainerEdge(executor, {
      onLog,
      image: IMAGE,
      config: TAKEOVER,
      verifyTimeoutMs: 50,
    });

    expect(result.converted).toBe(true);
    // The ordering is the safety property: a registry failure must not be able to
    // leave a live box with its proxy stopped and no container to replace it.
    expect(idx(commands, "docker pull")).toBeGreaterThanOrEqual(0);
    expect(idx(commands, "docker pull")).toBeLessThan(idx(commands, STOP_UNIT));
    // How to put it back is recorded BEFORE it goes down, not after.
    expect(idx(commands, `writeFile ${JOURNAL_PATH}`)).toBeLessThan(idx(commands, STOP_UNIT));
  });

  // The journal is what boot recovery replays. Left behind after a SUCCESSFUL
  // migration, the next reboot dutifully restarts the proxy we just migrated off and
  // it races our edge for :80.
  it("clears the takeover journal once the edge is proven serving", async () => {
    const { executor, files, onLog } = box({ hostOpenResty: true });
    await ensureContainerEdge(executor, {
      onLog,
      image: IMAGE,
      config: TAKEOVER,
      verifyTimeoutMs: 50,
    });

    expect(files.has(JOURNAL_PATH)).toBe(false);
  });

  it("aborts on a failed pull with the old proxy untouched", async () => {
    const { executor, commands, onLog } = box({ hostOpenResty: true, pullFails: true });

    await expect(
      ensureContainerEdge(executor, { onLog, image: IMAGE, config: TAKEOVER }),
    ).rejects.toThrow(/Could not pull the edge image/);
    expect(commands.some((c) => c.includes("systemctl disable --now"))).toBe(false);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(false);
  });

  it("rolls back to the host OpenResty when the container won't start", async () => {
    // This is the failure the auto-migrate-on-deploy path has to survive: the box was
    // serving before we touched it, so it must be serving after we fail.
    const { executor, commands, onLog } = box({ hostOpenResty: true, runFails: true });

    await expect(
      ensureContainerEdge(executor, { onLog, image: IMAGE, config: TAKEOVER }),
    ).rejects.toThrow(/Edge container setup failed/);
    expect(commands.some((c) => c.startsWith("docker rm -f"))).toBe(true);
    expect(commands.some((c) => c.includes(RESTORE_UNIT))).toBe(true);
  });

  it("rolls back when the container starts but its config is invalid", async () => {
    const { executor, commands, onLog } = box({ hostOpenResty: true, configInvalid: true });

    await expect(
      ensureContainerEdge(executor, { onLog, image: IMAGE, config: TAKEOVER }),
    ).rejects.toThrow(/Edge container setup failed/);
    expect(commands.some((c) => c.includes(RESTORE_UNIT))).toBe(true);
  });

  it("rolls back when the container is up but nothing is listening on :80", async () => {
    // `docker run` exiting 0 proves only that the daemon accepted it — a container
    // that starts and immediately dies would otherwise read as a success.
    const { executor, commands, onLog } = box({ hostOpenResty: true, notListening: true });

    await expect(
      ensureContainerEdge(executor, {
        onLog,
        image: IMAGE,
        config: TAKEOVER,
        verifyTimeoutMs: 50,
      }),
    ).rejects.toThrow(/nothing is listening on :80/);
    expect(commands.some((c) => c.includes(RESTORE_UNIT))).toBe(true);
  });

  it("does not pretend to restore a proxy on a box that was already free", async () => {
    const { executor, commands, onLog } = box({ runFails: true });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow();
    expect(commands.some((c) => c.includes("systemctl enable --now"))).toBe(false);
  });

  // No pre-accepted policy and no prompt callback → the gate must REFUSE, not guess.
  // The pull already happened (deliberately: it's the step that must fail while the
  // box is still untouched), but nothing may be stopped or started.
  it("refuses — without touching the proxy — when no consent is available", async () => {
    const { executor, commands, onLog } = box({ hostOpenResty: true });

    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow(
      /Accept a migrate or takeover to continue/,
    );
    expect(commands.some((c) => c.includes("systemctl disable --now"))).toBe(false);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(false);
    expect(commands.some((c) => c.startsWith("writeFile"))).toBe(false);
  });

  // "I stopped its owner" and ":80 is bindable" are different facts, and only the
  // second one lets our edge start. Installing on the first would start a container
  // that loses the race and crash-loops on `bind() … (98: Address already in use)`
  // while `docker run` exits 0 — i.e. a reported-successful migration of a box that
  // is now serving nothing.
  it("refuses to install — and restores the proxy — when the ports never come free", async () => {
    vi.useFakeTimers();
    try {
      const { executor, commands, onLog } = box({ hostOpenResty: true, portStaysBound: true });
      // The socket-drain wait is a real 15s budget, so drive it with fake timers
      // rather than shrinking the production timeout to suit the test.
      const settled = ensureContainerEdge(executor, {
        onLog,
        image: IMAGE,
        config: TAKEOVER,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const err = (await settled) as { code?: string; message?: string } | null;

      expect(err?.code).toBe("EDGE_PORTS_STILL_BOUND");
      expect(err?.message).toMatch(/port 80 is still in use/);
      expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(false);
      expect(commands.some((c) => c.includes(RESTORE_UNIT))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses with an actionable message when Docker is missing", async () => {
    const { executor, onLog } = box({ dockerMissing: true });
    await expect(ensureContainerEdge(executor, { onLog, image: IMAGE })).rejects.toThrow(
      /Docker isn't available/,
    );
  });
});

// Create-path image acquisition: pull only when the image ISN'T already on the box.
// In dev, `deliverManagedImage` builds the content-derived `…-dev.<hash>` tag on the
// control plane and ships it here first, so bring-up finds it present and skips the
// pull (the tag is unpublished — a pull would 404). In prod the tag is absent, so it
// pulls `:APP_VERSION` exactly as the pull-path tests above assert.
describe("ensureContainerEdge — image acquisition gate", () => {
  it("pulls on create when the image isn't already on the box (prod)", async () => {
    const { executor, commands, onLog } = box({ imagePresent: false });
    await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    expect(commands.some((c) => c === `docker pull '${IMAGE}'`)).toBe(true);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(true);
  });

  it("does NOT pull on create when the image is already present (delivered dev tag)", async () => {
    const { executor, commands, onLog } = box({ imagePresent: true });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    expect(result.converted).toBe(false);
    expect(commands.some((c) => c.startsWith("docker pull"))).toBe(false);
    expect(commands.some((c) => c.startsWith("docker run -d"))).toBe(true);
  });

  // From-source (dev) backstop: the tag is unpublished, so an absent image means the
  // control-plane build/ship didn't complete. Pulling can only 404 and blame the
  // registry, so bring-up throws a clear "build didn't complete" error and never pulls.
  it("throws instead of pulling an absent image when managed images are from source", async () => {
    setManagedImagesFromSource("edge", true);
    try {
      const { executor, commands, onLog } = box({ imagePresent: false });
      await expect(
        ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 }),
      ).rejects.toThrow(/from-source edge image .* isn't on this server/);
      expect(commands.some((c) => c.startsWith("docker pull"))).toBe(false);
    } finally {
      setManagedImagesFromSource("edge", false);
    }
  });

  it("swaps a serving edge onto a new tag with no pull when that tag is already present", async () => {
    // The delivered dev tag differs from the running container's tag (the source hash
    // moved), so it's stale — but it's already on the box, so the swap runs no pull.
    const { executor, commands, onLog } = box({
      edgeContainer: "openship-edge",
      edgeContainerImage: "ghcr.io/oblien/openship-edge:1.0.0",
      imagePresent: true,
    });
    const result = await ensureContainerEdge(executor, { onLog, image: IMAGE, verifyTimeoutMs: 50 });

    expect(result.updated).toBe(true);
    expect(commands.some((c) => c.startsWith("docker pull"))).toBe(false);
    expect(commands.some((c) => c.includes(`docker run -d --name 'openship-edge'`))).toBe(true);
  });
});
