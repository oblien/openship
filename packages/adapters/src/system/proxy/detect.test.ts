import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../types";
import {
  detectEdgeContainer,
  freeEdgeTargets,
  invalidateEdgeContainer,
  probeEdge,
  resolveOurEdgeContainer,
  stopTargetsForStatus,
} from "./detect";

/** Fake executor: maps a command (by substring) to canned stdout. Unmatched → "". */
function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  const exec = async (cmd: string): Promise<string> => {
    for (const [needle, out] of rules) {
      if (cmd.includes(needle)) return out;
    }
    return "";
  };
  return { exec } as unknown as CommandExecutor;
}

describe("probeEdge classification", () => {
  test("free when nothing listens on 80/443", async () => {
    const status = await probeEdge(makeExecutor([]));
    expect(status.classification).toBe("free");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("known when a DEPRECATED bare host OpenResty owns the ports (a migration source)", async () => {
    // The edge is a CONTAINER. A bare host OpenResty — even one an older Openship
    // apt-installed, with our Lua still on disk — is therefore a proxy to MIGRATE
    // FROM, exactly like a distro nginx: `known` (recognized AND importable), never
    // `ours`. Calling it ours is what returned canProceedClean, so the consent gate
    // stopped nothing, the edge container lost :80 and crash-looped forever on
    // `bind() … Address already in use` — while "Fix edge" reported success.
    const status = await probeEdge(
      makeExecutor([
        ["site_logger.lua", "ok"], // our Lua on the HOST proves nothing about ownership
        ["sport = :80", "LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=555,fd=6))"],
        ["sport = :443", "LISTEN 0 511 *:443 *:* users:((\"nginx\",pid=555,fd=8))"],
        ["-p 555 -o args=", "nginx: master process /usr/local/openresty/nginx/sbin/nginx"],
        ["/proc/555/cgroup", "0::/system.slice/openresty.service"],
        ["systemctl show openresty.service", "OpenResty"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.canProceedClean).toBe(false);
    expect(status.occupants.every((o) => o.proxy === "openresty")).toBe(true);
    expect(status.occupants.every((o) => o.managedByOpenship === false)).toBe(true);
    // One proxy on both ports → ONE stop target, and it's the unit (durable).
    const targets = stopTargetsForStatus(status);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.unit).toBe("openresty.service");
  });

  test("REGRESSION: a CRASH-LOOPING edge container does not make the ports 'ours'", async () => {
    // Docker calls a crash loop "running" (.State.Running == true, listed by plain
    // `docker ps`), so the self-takeover lock has to ask `.State.Status`. Without
    // that it claims whatever ACTUALLY holds :80 — the very proxy that caused the
    // loop — as our edge, ensureEdgeClear returns clean, nothing is stopped, and
    // every re-install reports success on a box serving nothing.
    const status = await probeEdge(
      makeExecutor([
        ["{{.State.Status}}", "restarting"],
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=1234,fd=6))'],
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=1234,fd=8))'],
        ["-p 1234 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
        ["/proc/1234/cgroup", "0::/system.slice/nginx.service"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.canProceedClean).toBe(false);
    expect(status.occupants.every((o) => o.managedByOpenship === false)).toBe(true);
  });

  test("known when a foreign nginx (systemd) owns the ports", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["sport = :80", "LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=1234,fd=6))"],
        ["sport = :443", "LISTEN 0 511 *:443 *:* users:((\"nginx\",pid=1234,fd=8))"],
        ["-p 1234 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
        ["/proc/1234/cgroup", "0::/system.slice/nginx.service"],
        ["systemctl show nginx.service", "A high performance web server"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.canProceedClean).toBe(false);
    const t = stopTargetsForStatus(status);
    expect(t.some((x) => x.unit === "nginx.service")).toBe(true);
    expect(status.occupants.every((o) => o.proxy === "nginx")).toBe(true);
  });

  test("REGRESSION: a foreign /usr/sbin/nginx is NOT 'ours' just because our Lua is on disk", async () => {
    // The hekai.org failure: a prior run left site_logger.lua behind (ourEdge=true),
    // but the process on :80 is the distro nginx — it must still be a takeover target,
    // never silently classified as our managed edge (which skipped the takeover).
    const status = await probeEdge(
      makeExecutor([
        ["site_logger.lua", "ok"], // our Lua from a past attempt
        ["sport = :80", "LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=1234,fd=6))"],
        ["sport = :443", "LISTEN 0 511 *:443 *:* users:((\"nginx\",pid=1234,fd=8))"],
        ["-p 1234 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
        ["/proc/1234/cgroup", "0::/system.slice/nginx.service"],
        ["/proc/1234/exe", "/usr/sbin/nginx"],
        ["systemctl show nginx.service", "A high performance web server"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.canProceedClean).toBe(false);
    expect(status.occupants.length).toBeGreaterThan(0);
    expect(status.occupants.every((o) => o.managedByOpenship === false)).toBe(true);
  });

  test("ours when the edge is our host-networked openship-edge container", async () => {
    // Container-edge topology: OpenResty runs as the `openship-edge` container
    // with host networking, so (a) our Lua is INSIDE the container (host test -f
    // misses it) and (b) `docker ps --filter publish` matches nothing (host net).
    // It must still classify as OURS — the container name lookup + openresty
    // listener prove it — not a foreign proxy we'd try to take over.
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=777,fd=6))'],
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=777,fd=8))'],
        ["-p 777 -o args=", "nginx: master process /usr/local/openresty/nginx/sbin/nginx"],
      ]),
    );
    expect(status.classification).toBe("ours");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("REGRESSION: host-net edge container is OURS even when the host can't prove the listener binary", async () => {
    // The self-takeover bug: our openship-edge runs host-networked, but the host
    // renders the master as a bare `nginx: master process nginx …` (no openresty
    // prefix) and `readlink /proc/<pid>/exe` is denied — so listenerIsOurOpenResty
    // returns false. The RUNNING edge container must STILL make the edge ours;
    // otherwise ensureEdgeClear takes over (kills) our own edge and installs a rival.
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=777,fd=6))'],
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=777,fd=8))'],
        ["-p 777 -o args=", "nginx: master process nginx -g daemon off;"], // no openresty prefix
        // /proc/777/exe intentionally unmocked → readlink returns "" (denied)
      ]),
    );
    expect(status.classification).toBe("ours");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("ours when a RENAMED edge container runs our image (OPENSHIP_EDGE_CONTAINER)", async () => {
    // Default-name filter misses a renamed container; the full listing matches by
    // image, so a custom-named edge is still ours (never a self-takeover target).
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --format '{{.Names}}\t{{.Image}}'", "my-edge\tghcr.io/oblien/openship-edge:latest"],
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=777,fd=6))'],
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=777,fd=8))'],
        ["-p 777 -o args=", "nginx: master process nginx -g daemon off;"],
      ]),
    );
    expect(status.classification).toBe("ours");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("still 'known' when a foreign DOCKER proxy holds the ports even if our edge container also appears", async () => {
    // Defense: containerRunning must NOT claim a DIFFERENT docker proxy that
    // publishes the port — only our own host-net process. A foreign traefik on
    // the port stays a takeover target (can't co-bind with our edge anyway).
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["docker ps --filter publish=80", "traefik-1\ttraefik:v3.0"],
        ["docker ps --filter publish=443", "traefik-1\ttraefik:v3.0"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.occupants.every((o) => o.managedByOpenship === false)).toBe(true);
  });

  test("ours when a BRIDGED openship-edge container publishes 80/443", async () => {
    // Bridge mode: the edge container publishes the ports, so `docker ps --filter
    // publish` matches it. Recognized as ours by the openship-edge image name.
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter publish=80", "openship-edge\tghcr.io/oblien/openship-edge:latest"],
        ["docker ps --filter publish=443", "openship-edge\tghcr.io/oblien/openship-edge:latest"],
      ]),
    );
    expect(status.classification).toBe("ours");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("known when a dockerized traefik owns the ports", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter publish=80", "traefik-1\ttraefik:v3.0"],
        ["docker ps --filter publish=443", "traefik-1\ttraefik:v3.0"],
      ]),
    );
    expect(status.classification).toBe("known");
    expect(status.occupants[0]?.isDocker).toBe(true);
    expect(status.occupants[0]?.proxy).toBe("traefik");
    expect(stopTargetsForStatus(status).some((x) => x.container === "traefik-1")).toBe(true);
  });

  test("REGRESSION: a worker PID on the edge ports resolves to the nginx MASTER", async () => {
    // `ss` reports whichever nginx process holds the listening fd — on a
    // hand-started nginx that's a WORKER, whose own cgroup carries no unit. The
    // hekai run stopped that worker (twice, once per port); the master respawned
    // it and kept :80/:443, so the compose edge could never bind. The takeover
    // must target the master, and — since one proxy occupies both ports — exactly
    // ONE stop target.
    const status = await probeEdge(
      makeExecutor([
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=2588536,fd=6))'],
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=2588536,fd=8))'],
        ["-p 2588536 -o args=", "nginx: worker process"],
        ["/proc/2588536/status", "2588100"],
        ["-p 2588100 -o args=", "nginx: master process /usr/sbin/nginx -g daemon on;"],
      ]),
    );

    expect(status.classification).toBe("known");
    expect(status.occupants.every((o) => o.pid === 2588100)).toBe(true);

    const targets = stopTargetsForStatus(status);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.pid).toBe(2588100);
    expect(targets[0]?.label).toBe("nginx (PID 2588100)");
  });

  test("SELF-TAKEOVER LOCK: a WORKER of our own edge CONTAINER is still 'ours'", async () => {
    // The master hop must not turn our own edge into a foreign proxy. Our edge is
    // host-networked, so `ss` reports its worker as a plain host process (`nginx:
    // worker process`); the hop resolves the master, and the RUNNING, healthy edge
    // container is what proves the listener is ours.
    const status = await probeEdge(
      makeExecutor([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=910,fd=6))'],
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=910,fd=8))'],
        ["-p 910 -o args=", "nginx: worker process"],
        ["/proc/910/status", "900"],
        ["-p 900 -o args=", "nginx: master process /usr/local/openresty/nginx/sbin/nginx"],
      ]),
    );
    expect(status.classification).toBe("ours");
    expect(status.occupants).toHaveLength(0);
    expect(status.canProceedClean).toBe(true);
  });

  test("a master listener is used as-is (no PPid hop to systemd)", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["sport = :80", 'LISTEN 0 511 *:80 *:* users:(("nginx",pid=4242,fd=6))'],
        ["-p 4242 -o args=", "nginx: master process /usr/sbin/nginx"],
        ["/proc/4242/status", "1"],
      ]),
    );
    expect(status.occupants[0]?.pid).toBe(4242);
  });

  test("unknown when an unrecognized process holds a port", async () => {
    const status = await probeEdge(
      makeExecutor([
        ["sport = :80", "LISTEN 0 5 *:80 *:* users:((\"python3\",pid=999,fd=3))"],
        ["-p 999 -o args=", "python3 -m http.server 80"],
      ]),
    );
    expect(status.classification).toBe("unknown");
    expect(status.canProceedClean).toBe(false);
    expect(status.occupants[0]?.proxy).toBeUndefined();
  });
});

/**
 * "I stopped its owner" and ":80 is bindable" are different facts, and only the
 * second one lets the edge start. Every caller (consent gate, migrate, CLI preflight)
 * decides whether to proceed from this verdict, so a wrong `freed:true` is what makes
 * a crash-looping edge report as a successful install.
 */
describe("freeEdgeTargets", () => {
  /** /proc/net/tcp LISTEN rows for the given ports (hex local port, state 0A). */
  const procTable = (ports: number[]) =>
    ["  sl  local_address rem_address   st"]
      .concat(
        ports.map(
          (p, i) => `  ${i}: 00000000:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A`,
        ),
      )
      .join("\n");

  const UNIT = [{ unit: "openresty.service", label: "OpenResty" }];

  test("reports the ports that stayed bound instead of claiming success", async () => {
    const cmds: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        cmds.push(cmd);
        return cmd.includes("/proc/net/tcp") ? procTable([80, 443]) : "";
      },
    } as unknown as CommandExecutor;

    const res = await freeEdgeTargets(executor, UNIT, () => {}, { timeoutMs: 10 });

    expect(res).toEqual({ freed: false, stillBound: [80, 443] });
    // The unit is disabled, not just stopped, or it comes back on the next boot and
    // steals the ports from an edge that was fine when we walked away.
    expect(cmds.some((c) => c.includes("disable --now 'openresty.service'"))).toBe(true);
  });

  test("freed once the socket actually drains (a stop is not instant)", async () => {
    let bound = true;
    const executor = {
      exec: async (cmd: string) => {
        if (cmd.includes("disable --now")) {
          bound = false;
          return "";
        }
        return cmd.includes("/proc/net/tcp") ? procTable(bound ? [80, 443] : []) : "";
      },
    } as unknown as CommandExecutor;

    expect(await freeEdgeTargets(executor, UNIT, () => {}, { timeoutMs: 10 })).toEqual({
      freed: true,
      stillBound: [],
    });
  });

  test("an unreadable socket table is inconclusive — never reported as still bound", async () => {
    // checked:false is "no signal". Treating it as "still bound" would block a
    // takeover that in fact worked, on any box where reading procfs failed.
    const executor = {
      exec: async (cmd: string) => {
        if (cmd.includes("/proc/net/tcp")) throw new Error("ssh channel closed");
        return "";
      },
    } as unknown as CommandExecutor;

    expect(await freeEdgeTargets(executor, UNIT, () => {}, { timeoutMs: 10 })).toEqual({
      freed: true,
      stillBound: [],
    });
  });

  test("verifies only the port a target names", async () => {
    const executor = {
      exec: async (cmd: string) => (cmd.includes("/proc/net/tcp") ? procTable([443]) : ""),
    } as unknown as CommandExecutor;

    const res = await freeEdgeTargets(
      executor,
      [{ container: "traefik-1", port: 80 }],
      () => {},
      { timeoutMs: 10 },
    );
    // :443 is somebody else's business here (a target scoped to :80 was stopped).
    expect(res).toEqual({ freed: true, stillBound: [] });
  });
});

/**
 * The probe is 1–2 `docker ps` shell-outs — over SSH for a remote server — and it
 * sits on read paths that run constantly (every platform construction, every
 * component check, once per file in readEdgeFile/writeEdgeFile). These tests pin
 * the two things the memo must never get wrong: it must actually stop re-asking,
 * and it must never answer for the WRONG BOX.
 */
describe("resolveOurEdgeContainer memoization", () => {
  /** Executor that answers `docker ps` with `name` and counts how often it's asked. */
  function countingExecutor(name: string) {
    const state = { probes: 0 };
    const exec = async (cmd: string): Promise<string> => {
      if (!cmd.startsWith("docker ps")) return "";
      state.probes++;
      return name;
    };
    return { executor: { exec } as unknown as CommandExecutor, state };
  }

  test("asks the box once, then answers from the memo", async () => {
    const { executor, state } = countingExecutor("openship-edge");
    expect(await resolveOurEdgeContainer(executor)).toBe("openship-edge");
    expect(await resolveOurEdgeContainer(executor)).toBe("openship-edge");
    expect(await resolveOurEdgeContainer(executor)).toBe("openship-edge");
    expect(state.probes).toBe(1);
  });

  test("caches ABSENCE too — a bare box is the case that shelled out most", async () => {
    const { executor, state } = countingExecutor("");
    expect(await resolveOurEdgeContainer(executor)).toBeNull();
    expect(await resolveOurEdgeContainer(executor)).toBeNull();
    // A miss costs two commands (by-name, then list-all); it must still happen once.
    expect(state.probes).toBe(2);
  });

  test("never serves one box's answer for another", async () => {
    const a = countingExecutor("openship-edge");
    const b = countingExecutor("");
    expect(await resolveOurEdgeContainer(a.executor)).toBe("openship-edge");
    // Same question, different machine: a bare server must not inherit the
    // container name from the one probed before it.
    expect(await resolveOurEdgeContainer(b.executor)).toBeNull();
    expect(await resolveOurEdgeContainer(a.executor)).toBe("openship-edge");
  });

  test("fresh: true bypasses the memo — the install/uninstall contract", async () => {
    const { executor, state } = countingExecutor("openship-edge");
    await resolveOurEdgeContainer(executor);
    await resolveOurEdgeContainer(executor, { fresh: true });
    expect(state.probes).toBe(2);
  });

  test("invalidating one executor re-probes only that box", async () => {
    const a = countingExecutor("openship-edge");
    const b = countingExecutor("openship-edge");
    await resolveOurEdgeContainer(a.executor);
    await resolveOurEdgeContainer(b.executor);

    invalidateEdgeContainer(a.executor);
    await resolveOurEdgeContainer(a.executor);
    await resolveOurEdgeContainer(b.executor);
    expect(a.state.probes).toBe(2);
    expect(b.state.probes).toBe(1);
  });

  test("invalidating with no executor clears every box", async () => {
    const a = countingExecutor("openship-edge");
    const b = countingExecutor("openship-edge");
    await resolveOurEdgeContainer(a.executor);
    await resolveOurEdgeContainer(b.executor);

    invalidateEdgeContainer();
    await resolveOurEdgeContainer(a.executor);
    await resolveOurEdgeContainer(b.executor);
    expect(a.state.probes).toBe(2);
    expect(b.state.probes).toBe(2);
  });

  test("a re-probe after invalidation reports the NEW state, not the old one", async () => {
    // The scenario the invalidation calls exist for: the edge is removed (or
    // created) and the next reader must not be told the previous story.
    let present = true;
    const executor = {
      exec: async (cmd: string) => (cmd.startsWith("docker ps") && present ? "openship-edge" : ""),
    } as unknown as CommandExecutor;

    expect(await resolveOurEdgeContainer(executor)).toBe("openship-edge");
    present = false;
    expect(await resolveOurEdgeContainer(executor)).toBe("openship-edge"); // still memoized
    invalidateEdgeContainer(executor);
    expect(await resolveOurEdgeContainer(executor)).toBeNull();
  });
});

describe("detectEdgeContainer", () => {
  // Unlike resolveOurEdgeContainer (running-only), this reads `docker ps -a` so a
  // stopped edge is still tracked. One line per case: name<TAB>image<TAB>state.
  const psa = (line: string) =>
    makeExecutor([["docker ps -a", line]]);

  test("finds a RUNNING edge by name and reports its image", async () => {
    expect(
      await detectEdgeContainer(psa("openship-edge\tghcr.io/oblien/openship-edge:0.5.0\trunning")),
    ).toEqual({
      name: "openship-edge",
      image: "ghcr.io/oblien/openship-edge:0.5.0",
      running: true,
      exists: true,
    });
  });

  test("finds a STOPPED edge — exists but not running (the track-if-installed case)", async () => {
    expect(
      await detectEdgeContainer(psa("openship-edge\tghcr.io/oblien/openship-edge:0.4.0\texited")),
    ).toMatchObject({ name: "openship-edge", running: false, exists: true });
  });

  test("matches a container renamed off the default name but running our image", async () => {
    expect(
      await detectEdgeContainer(psa("my-proxy\tghcr.io/oblien/openship-edge:0.5.0\trunning")),
    ).toMatchObject({ name: "my-proxy", running: true, exists: true });
  });

  test("reports absent when only foreign containers exist", async () => {
    expect(await detectEdgeContainer(psa("some-app\tnginx:latest\trunning"))).toEqual({
      name: null,
      running: false,
      image: null,
      exists: false,
    });
  });

  test("reports absent when docker returns nothing", async () => {
    expect(await detectEdgeContainer(makeExecutor([]))).toEqual({
      name: null,
      running: false,
      image: null,
      exists: false,
    });
  });

  test("returns null (inconclusive) when the docker probe itself errors — NOT absent", async () => {
    // A `docker ps -a` that throws (daemon unreachable, SSH dropped) must not read
    // as "no edge here": the drift cache keys off this to keep the last-known row.
    const executor = {
      exec: async () => {
        throw new Error("ssh channel closed");
      },
    } as unknown as CommandExecutor;
    expect(await detectEdgeContainer(executor)).toBeNull();
  });
});
