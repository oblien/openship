import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { PromptPayload, PromptUserFn } from "./deploy-pipeline";
import {
  ensurePortAvailable,
  portOccupantDetails,
  probeListeningPort,
  probeListeningPortOwners,
  probeListeningPortState,
} from "./port-conflict";
import {
  containerIdFromCgroup,
  isContainerPortForwarder,
  mayStopUnitForAppPort,
  mayStopUnitForEdgeTakeover,
} from "../system/port-owner";

/** Fake host: maps a command (by substring) to canned stdout; unmatched → "". */
function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  const exec = async (cmd: string): Promise<string> => {
    for (const [needle, out] of rules) {
      if (cmd.includes(needle)) return out;
    }
    return "";
  };
  return { exec } as unknown as CommandExecutor;
}

/** A single /proc/net/tcp data row in LISTEN state (0A) on the given port. */
function procListenRow(port: number): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return `  1: 00000000:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345 1 0000 100 0 0 10 0`;
}

/**
 * The port is only touched by an OUTBOUND connection — nothing is LISTENing.
 * An unfiltered `lsof -ti tcp:PORT` returns that PID; a `-sTCP:LISTEN`-filtered
 * lsof returns nothing, and procfs shows no LISTEN row. Regression for #85.
 */
function outboundOnlyHost(port: number, outboundPid: number): CommandExecutor {
  const exec = async (cmd: string): Promise<string> => {
    if (cmd.includes(`lsof -ti tcp:${port}`)) {
      return cmd.includes("-sTCP:LISTEN") ? "" : `${outboundPid}\n`;
    }
    return ""; // procfs (no LISTEN row) + ps/cgroup follow-ups: nothing.
  };
  return { exec } as unknown as CommandExecutor;
}

describe("probeListeningPort — LISTEN-state filter (regression #85)", () => {
  // Behavioral: an outbound-only host must probe as free (null). Fails on the
  // unfiltered probe (lsof returns the outbound PID); passes once filtered.
  test("returns null when only an outbound connection uses the port", async () => {
    expect(await probeListeningPort(outboundOnlyHost(443, 4242), 443)).toBeNull();
  });

  // Command-shape: the emitted lsof fallback must carry the LISTEN state filter.
  test("emitted lsof fallback carries -sTCP:LISTEN", async () => {
    const seen: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        seen.push(cmd);
        return "";
      },
    } as unknown as CommandExecutor;

    await probeListeningPort(executor, 443);

    const probe = seen.find((c) => c.includes("lsof -ti tcp:443"));
    expect(probe).toBeDefined();
    expect(probe).toContain("-sTCP:LISTEN");
  });
});

describe("probeListeningPort — tiered fallback", () => {
  test("tier 1: ss resolves the owner PID and command", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=555,fd=8))'],
        ["-p 555 -o args=", "nginx: master process /usr/sbin/nginx"],
      ]),
      443,
    );
    expect(occ?.pid).toBe(555);
    expect(occ?.command).toContain("nginx");
  });

  test("tier 2: lsof fallback resolves the PID when ss is empty", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["lsof -ti tcp:443", "777\n"],
        ["-p 777 -o args=", "python3 -m http.server 443"],
      ]),
      443,
    );
    expect(occ?.pid).toBe(777);
    expect(occ?.command).toContain("python3");
  });

  test("tier 3: procfs reports occupancy with unknown owner when ss+lsof are absent", async () => {
    const occ = await probeListeningPort(
      makeExecutor([["/proc/net/tcp", procListenRow(443)]]),
      443,
    );
    expect(occ).not.toBeNull();
    expect(occ?.pid).toBeNull();
    expect(occ?.command).toBe("unknown listener");
  });

  test("non-root ss (LISTEN line without a PID) still reports occupancy via procfs", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["sport = :443", "LISTEN 0 511 *:443 *:*"], // no users:((pid=...)) without privilege
        ["/proc/net/tcp", procListenRow(443)],
      ]),
      443,
    );
    expect(occ?.pid).toBeNull();
    expect(occ?.command).toBe("unknown listener");
  });

  test("non-root ss remains occupied when procfs cannot confirm the listener", async () => {
    const occ = await probeListeningPort(
      makeExecutor([["sport = :443", "LISTEN 0 511 *:443 *:*"]]),
      443,
    );
    expect(occ?.pid).toBeNull();
    expect(occ?.command).toBe("unknown listener");
  });

  test("strict callers can distinguish an unreadable socket table from a free port", async () => {
    const executor = {
      exec: async () => {
        throw new Error("SSH connection dropped");
      },
    } as unknown as CommandExecutor;

    await expect(probeListeningPortState(executor, 443)).resolves.toEqual({
      occupant: null,
      checked: false,
    });
    await expect(probeListeningPort(executor, 443)).resolves.toBeNull();
  });

  test("non-root ss resolves the PID through targeted passwordless sudo", async () => {
    const seen: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        seen.push(cmd);
        if (cmd.startsWith("sudo -n ss")) {
          return 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=888,fd=8))';
        }
        if (cmd.includes("sport = :443")) return "LISTEN 0 511 *:443 *:*";
        if (cmd.includes("-p 888 -o args=")) return "nginx: master process /usr/sbin/nginx";
        return "";
      },
    } as unknown as CommandExecutor;

    const occ = await probeListeningPort(executor, 443);

    expect(occ?.pid).toBe(888);
    expect(occ?.command).toContain("nginx: master process");
    expect(seen.some((cmd) => cmd.startsWith("sudo -n ss"))).toBe(true);
  });

  test("targeted sudo falls back to lsof when privileged ss is unavailable", async () => {
    const executor = {
      exec: async (cmd: string) => {
        if (cmd.startsWith("sudo -n ss")) return "999\n";
        if (cmd.includes("sport = :443")) return "LISTEN 0 511 *:443 *:*";
        if (cmd.includes("-p 999 -o args=")) return "openresty -g daemon on;";
        return "";
      },
    } as unknown as CommandExecutor;

    const occ = await probeListeningPort(executor, 443);

    expect(occ?.pid).toBe(999);
    expect(occ?.command).toContain("openresty");
  });

  test("does not request sudo when the unprivileged probe already exposes a PID", async () => {
    const seen: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        seen.push(cmd);
        if (cmd.includes("sport = :443")) {
          return 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=555,fd=8))';
        }
        if (cmd.includes("-p 555 -o args=")) return "nginx: master process /usr/sbin/nginx";
        return "";
      },
    } as unknown as CommandExecutor;

    expect((await probeListeningPort(executor, 443))?.pid).toBe(555);
    expect(seen.some((cmd) => cmd.startsWith("sudo -n "))).toBe(false);
  });

  test("free port: no tool and no procfs row → null", async () => {
    expect(await probeListeningPort(makeExecutor([]), 443)).toBeNull();
  });

  // SO_REUSEPORT: lsof prints one PID per line. The old `^(\d+)$` full-string
  // regex matched none of them → false "free"; the per-line regex takes the first.
  test("multiple listener PIDs (SO_REUSEPORT) resolves the first, not free", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["lsof -ti tcp:8080", "1001\n1002\n1003"],
        ["-p 1001 -o args=", "envoy -c /etc/envoy.yaml"],
      ]),
      8080,
    );
    expect(occ?.pid).toBe(1001);
    expect(occ?.command).toContain("envoy");
  });

  test("strict owner enumeration preserves every SO_REUSEPORT listener", async () => {
    const owners = await probeListeningPortOwners(
      makeExecutor([
        ["lsof -ti tcp:8080", "1001\n1002"],
        ["-p 1001 -o args=", "nginx: master process /managed/openresty"],
        ["-p 1002 -o args=", "envoy -c /etc/envoy.yaml"],
        ["/proc/1001/cgroup", "0::/system.slice/managed.service"],
        ["/proc/1002/cgroup", "0::/system.slice/envoy.service"],
      ]),
      8080,
    );

    expect(owners.checked).toBe(true);
    expect(owners.ownershipComplete).toBe(true);
    expect(owners.occupants.map((owner) => owner.pid)).toEqual([1001, 1002]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #628 — a published container port must never resolve to the Docker daemon
// ─────────────────────────────────────────────────────────────────────────────

/** A rule's `null` output means the command FAILED (non-zero exit), which is what
 *  separates "docker couldn't answer" from "docker answered, nothing there". */
type Rule = [needle: string, out: string | null];

/**
 * Fake host that RECORDS every command it was asked to run. Recording is the point:
 * the regression this suite guards is a command that must NEVER be emitted, and only
 * the full command list can prove absence.
 */
function recordingHost(rules: () => Rule[]) {
  const seen: string[] = [];
  const exec = async (cmd: string): Promise<string> => {
    seen.push(cmd);
    for (const [needle, out] of rules()) {
      if (cmd.includes(needle)) {
        if (out === null) throw new Error(`command failed: ${cmd}`);
        return out;
      }
    }
    return "";
  };
  return { seen, executor: { exec } as unknown as CommandExecutor };
}

function fakeLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: { log: (m: string) => void lines.push(m) } as unknown as BuildLogger,
  };
}

/** 64-hex, the shape `--no-trunc` prints and a cgroup carries. */
const CID = `${"a1b2c3d4e5f6".repeat(5)}abcd`;
const PORT = 8080;
const PROXY_PID = 4321;

const SS_DOCKER_PROXY = `LISTEN 0 4096 0.0.0.0:${PORT} 0.0.0.0:* users:(("docker-proxy",pid=${PROXY_PID},fd=4))`;
const PS_DOCKER_PROXY =
  `/usr/bin/docker-proxy -proto tcp -host-ip 0.0.0.0 -host-port ${PORT} ` +
  `-container-ip 172.17.0.2 -container-port 3000`;
/** docker-proxy is a dockerd CHILD, so its cgroup names the daemon — the bug's source. */
const CGROUP_DOCKER_SERVICE = "0::/system.slice/docker.service";

/** One `docker ps --no-trunc --format` line. Empty labels keep their column. */
function psLine(opts: {
  id?: string;
  name: string;
  image?: string;
  project?: string;
  deployment?: string;
  service?: string;
  build?: string;
  composeProject?: string;
  composeService?: string;
}): string {
  return [
    opts.id ?? CID,
    opts.name,
    opts.image ?? "openship/myapp:latest",
    opts.project ?? "",
    opts.deployment ?? "",
    opts.service ?? "",
    opts.build ?? "",
    opts.composeProject ?? "",
    opts.composeService ?? "",
  ].join("\t");
}

const OWNED_LINE = psLine({
  name: "openship-myapp-web",
  project: "proj_abc",
  deployment: "dep_1",
  service: "web",
});

/** Commands that free a port by taking down something bigger than the port. */
function forbiddenCommands(seen: string[]): string[] {
  return seen.filter(
    (c) =>
      /\bsystemctl\s+(stop|disable)/.test(c) ||
      /\bkill\b/.test(c) ||
      // Any mutation naming a daemon at all.
      /docker\.service|containerd\.service|user@\d+\.service|docker\.socket/.test(c),
  );
}

/**
 * A refusal still HOLDS the deploy — the prompt is the operator's window to free the
 * port by hand — but it must offer no stop of its own. Asserting the shape rather than
 * "no prompt at all" is the point: the wrong version of this offered "Free Port &
 * Continue" for something it could not free.
 */
function expectRefusalPrompt(spy: PromptSpy): void {
  expect(spy.calls).toHaveLength(1);
  const ids = spy.calls[0]!.actions.map((a) => a.id);
  expect(ids).not.toContain("free_port");
  expect(ids).toContain("re_check");
  expect(spy.calls[0]!.details).toMatchObject({ stopTarget: "none" });
}

interface PromptSpy {
  calls: PromptPayload[];
  promptUser: PromptUserFn;
}
function promptSpy(answer: string): PromptSpy {
  const calls: PromptPayload[] = [];
  return {
    calls,
    promptUser: async (p) => {
      calls.push(p);
      return answer;
    },
  };
}

describe("ensurePortAvailable — docker-published port (#628)", () => {
  test("a stale Openship container is stopped by id, and the daemon is never touched", async () => {
    let stopped = false;
    const host = recordingHost(() => [
      [`sport = :${PORT}`, stopped ? "" : SS_DOCKER_PROXY],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [`--filter publish=${PORT}`, stopped ? "" : OWNED_LINE],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");
    // The stop is what flips the host to "free"; recorded before the re-probe runs.
    const exec = host.executor.exec.bind(host.executor);
    (host.executor as { exec: typeof exec }).exec = async (cmd: string) => {
      const out = await exec(cmd);
      if (cmd.includes("docker stop")) stopped = true;
      return out;
    };

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).resolves.toBeUndefined();

    expect(spy.calls).toHaveLength(1);
    const prompt = spy.calls[0]!;
    expect(prompt.actions[0]!.label).toBe("Stop Openship Container & Continue");
    expect(prompt.details).toMatchObject({
      stopTarget: "container",
      containerId: CID,
      containerName: "openship-myapp-web",
      ownerProjectId: "proj_abc",
      deploymentId: "dep_1",
      serviceName: "web",
      isManagedDeployment: true,
      dockerPublished: true,
    });
    // The daemon's unit must not even be REPORTED as this occupant's owner.
    expect(prompt.details!.systemdUnit).toBeUndefined();

    expect(host.seen.some((c) => c.includes(`docker stop '${CID}'`))).toBe(true);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("a foreign container is offered as a container stop, ownership left unasserted", async () => {
    const host = recordingHost(() => [
      [`sport = :${PORT}`, SS_DOCKER_PROXY],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [`--filter publish=${PORT}`, psLine({ name: "somebody-redis", image: "redis:7" })],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("abort");

    await expect(ensurePortAvailable(host.executor, PORT, logger, spy.promptUser)).rejects.toThrow(
      /port 8080/i,
    );

    expect(spy.calls[0]!.actions[0]!.label).toBe("Stop Container & Continue");
    // A container with no openship label may still be an ADOPTED one of ours, so we
    // must not claim it isn't managed — `undefined` is the honest answer.
    expect(spy.calls[0]!.details!.isManagedDeployment).toBeUndefined();
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("docker cannot answer: no free action is offered at all, and nothing is stopped", async () => {
    const host = recordingHost(() => [
      [`sport = :${PORT}`, SS_DOCKER_PROXY],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      // No docker CLI / no socket permission → the command FAILS. Distinct from "".
      [`--filter publish=${PORT}`, null],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(ensurePortAvailable(host.executor, PORT, logger, spy.promptUser)).rejects.toThrow(
      /Docker's port forwarder/,
    );

    expectRefusalPrompt(spy);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("two containers publish the port: ambiguous, so neither is stopped", async () => {
    const host = recordingHost(() => [
      [`sport = :${PORT}`, SS_DOCKER_PROXY],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [
        `--filter publish=${PORT}`,
        `${psLine({ name: "app-a", project: "proj_a" })}\n${psLine({ id: "b".repeat(64), name: "app-b", project: "proj_b" })}`,
      ],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(ensurePortAvailable(host.executor, PORT, logger, spy.promptUser)).rejects.toThrow(
      /2 containers/,
    );
    expectRefusalPrompt(spy);
    expect(host.seen.some((c) => c.includes("docker stop"))).toBe(false);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("our own edge container is never offered as a stop target", async () => {
    const host = recordingHost(() => [
      ["sport = :80", SS_DOCKER_PROXY.replace(`:${PORT}`, ":80")],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [
        "--filter publish=80",
        psLine({ name: "openship-edge", image: "ghcr.io/oblien/openship-edge:latest" }),
      ],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(ensurePortAvailable(host.executor, 80, logger, spy.promptUser)).rejects.toThrow(
      /Openship edge proxy/,
    );
    expectRefusalPrompt(spy);
    expect(host.seen.some((c) => c.includes("docker stop"))).toBe(false);
  });

  test("rootless docker: the operator's user manager is never a stop target", async () => {
    const host = recordingHost(() => [
      [
        `sport = :${PORT}`,
        `LISTEN 0 4096 0.0.0.0:${PORT} 0.0.0.0:* users:(("rootlesskit",pid=${PROXY_PID},fd=9))`,
      ],
      [
        `-p ${PROXY_PID} -o args=`,
        "rootlesskit --net=slirp4netns --copy-up=/etc --port-driver=builtin",
      ],
      [`/proc/${PROXY_PID}/cgroup`, "0::/user.slice/user-1000.slice/user@1000.service/init.scope"],
      [`--filter publish=${PORT}`, null],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).rejects.toThrow();
    expectRefusalPrompt(spy);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("--userland-proxy=false: nothing LISTENs, but the container still owns the port", async () => {
    // Pure iptables DNAT — the socket table is empty, so this probed FREE before the
    // fix and the deploy then died on docker's own "port is already allocated".
    const host = recordingHost(() => [[`--filter publish=${PORT}`, OWNED_LINE]]);
    const { logger } = fakeLogger();
    const spy = promptSpy("abort");

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).rejects.toThrow();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.details).toMatchObject({
      stopTarget: "container",
      containerId: CID,
      pid: null,
    });
  });

  test("host-networked container: resolved through its cgroup, not left a kill -9 target", async () => {
    const NGINX_PID = 991;
    const host = recordingHost(() => [
      [
        `sport = :${PORT}`,
        `LISTEN 0 511 0.0.0.0:${PORT} 0.0.0.0:* users:(("nginx",pid=${NGINX_PID},fd=8))`,
      ],
      [`-p ${NGINX_PID} -o args=`, "nginx: master process nginx -g daemon off;"],
      [`/proc/${NGINX_PID}/cgroup`, `0::/system.slice/docker-${CID}.scope`],
      // Host networking publishes nothing, so the publish filter finds nobody...
      [`--filter publish=${PORT}`, ""],
      // ...and the container is only reachable by the id read off the cgroup.
      [`--filter id='${CID}'`, psLine({ name: "legacy-proxy", image: "nginx:1.27" })],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("abort");

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).rejects.toThrow();
    expect(spy.calls[0]!.details).toMatchObject({
      stopTarget: "container",
      containerName: "legacy-proxy",
    });
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });
});

describe("ensurePortAvailable — systemd occupants keep working", () => {
  test("Openship's own deployment unit is still stopped by name", async () => {
    const UNIT = "openship-dep_Ab3xY9zQ.service";
    let stopped = false;
    const host = recordingHost(() => [
      [
        `sport = :${PORT}`,
        stopped ? "" : `LISTEN 0 511 *:${PORT} *:* users:(("node",pid=700,fd=18))`,
      ],
      ["-p 700 -o args=", "node /srv/app/server.js"],
      ["/proc/700/cgroup", `0::/system.slice/${UNIT}`],
      ["--property=Description", "Openship deployment dep_Ab3xY9zQ"],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");
    const exec = host.executor.exec.bind(host.executor);
    (host.executor as { exec: typeof exec }).exec = async (cmd: string) => {
      const out = await exec(cmd);
      if (cmd.includes("systemctl stop")) stopped = true;
      return out;
    };

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).resolves.toBeUndefined();
    expect(spy.calls[0]!.actions[0]!.label).toBe("Stop Openship Deployment & Continue");
    expect(spy.calls[0]!.details).toMatchObject({
      stopTarget: "unit",
      isManagedDeployment: true,
      deploymentId: "dep_Ab3xY9zQ",
    });
    expect(host.seen.some((c) => c.includes(`systemctl stop '${UNIT}'`))).toBe(true);
  });

  test("a genuine foreign service is still offered — the fix is not a blanket refusal", async () => {
    let stopped = false;
    const host = recordingHost(() => [
      [
        `sport = :${PORT}`,
        stopped ? "" : `LISTEN 0 511 *:${PORT} *:* users:(("mysqld",pid=800,fd=4))`,
      ],
      ["-p 800 -o args=", "/usr/sbin/mysqld --port=8080"],
      ["/proc/800/cgroup", "0::/system.slice/mysql.service"],
      ["--property=Description", "MySQL Community Server"],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");
    const exec = host.executor.exec.bind(host.executor);
    (host.executor as { exec: typeof exec }).exec = async (cmd: string) => {
      const out = await exec(cmd);
      if (cmd.includes("systemctl stop")) stopped = true;
      return out;
    };

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).resolves.toBeUndefined();
    expect(spy.calls[0]!.actions[0]!.label).toBe("Stop Service & Continue");
    expect(spy.calls[0]!.details).toMatchObject({ stopTarget: "unit", isManagedDeployment: false });
    expect(host.seen.some((c) => c.includes("systemctl stop 'mysql.service'"))).toBe(true);
  });

  test("sshd holding the port is refused rather than offered", async () => {
    const host = recordingHost(() => [
      ["sport = :22", 'LISTEN 0 128 *:22 *:* users:(("sshd",pid=600,fd=3))'],
      ["-p 600 -o args=", "sshd: /usr/sbin/sshd -D [listener]"],
      ["/proc/600/cgroup", "0::/system.slice/ssh.service"],
      ["--property=Description", "OpenBSD Secure Shell server"],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(ensurePortAvailable(host.executor, 22, logger, spy.promptUser)).rejects.toThrow(
      /will not stop/,
    );
    expectRefusalPrompt(spy);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test('openship-dev.service is the control plane, not a deployment with id "dev"', async () => {
    const host = recordingHost(() => [
      [`sport = :${PORT}`, `LISTEN 0 511 *:${PORT} *:* users:(("bun",pid=900,fd=20))`],
      ["-p 900 -o args=", "bun run apps/api/src/index.ts"],
      ["/proc/900/cgroup", "0::/system.slice/openship-dev.service"],
      ["--property=Description", "Openship (dev)"],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).rejects.toThrow();
    expectRefusalPrompt(spy);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("a docker-less bare host: a failed docker query does not block a managed unit stop", async () => {
    const UNIT = "openship-dep_Zz1.service";
    let stopped = false;
    const host = recordingHost(() => [
      [
        `sport = :${PORT}`,
        stopped ? "" : `LISTEN 0 511 *:${PORT} *:* users:(("node",pid=701,fd=18))`,
      ],
      ["-p 701 -o args=", "node /srv/app/server.js"],
      ["/proc/701/cgroup", `0::/system.slice/${UNIT}`],
      ["--property=Description", "Openship deployment"],
      // No docker on this box at all: "couldn't ask" must stay inert.
      [`--filter publish=${PORT}`, null],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");
    const exec = host.executor.exec.bind(host.executor);
    (host.executor as { exec: typeof exec }).exec = async (cmd: string) => {
      const out = await exec(cmd);
      if (cmd.includes("systemctl stop")) stopped = true;
      return out;
    };

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).resolves.toBeUndefined();
    expect(host.seen.some((c) => c.includes(`systemctl stop '${UNIT}'`))).toBe(true);
  });
});

describe("container port-forwarder recognition", () => {
  // A substring match on the command line read a real app as dockerd's forwarder and
  // made its port unfreeable. Only argv0's basename may decide this.
  test.each([
    ["/usr/bin/docker-proxy -proto tcp -host-port 8080 -container-port 3000", true],
    ["docker-proxy", true],
    ["rootlesskit --port-driver=builtin", true],
    ["/usr/bin/slirp4netns --api-socket /run/x", true],
    ["containerd-shim-runc-v2 -namespace moby -id abc", false], // a supervisor, not a forwarder
    ["node /srv/docker-proxy/server.js", false],
    ["/opt/pasta/bin/myapp --serve", false],
    ["python3 -m http.server 8080", false],
    ["nginx: master process /usr/sbin/nginx", false],
    ["", false],
  ])("%s → %s", (command, expected) => {
    expect(isContainerPortForwarder(command)).toBe(expected);
  });
});

describe("mayStopUnitForAppPort — the deploy's gate", () => {
  test.each([
    ["openship-dep_Ab3xY9zQ.service", true],
    ["mysql.service", true], // a genuine third-party service is a real answer
    // A proxy fronts every routed domain on the box, so trading it for one app's port
    // is never what the operator meant — even though the takeover gate below allows it.
    // All of these come from ONE rule now (classifyProxy), so haproxy/traefik/httpd are
    // covered without anyone having remembered to add them to a second list.
    ["openresty.service", false],
    ["nginx.service", false],
    ["apache2.service", false],
    ["httpd.service", false],
    ["caddy.service", false],
    ["haproxy.service", false],
    ["traefik.service", false],
    ["docker.service", false],
    ["docker.socket", false],
    ["containerd.service", false],
    ["snap.lxd.daemon.service", false],
    ["k3s.service", false],
    ["user@1000.service", false],
    ["snap.docker.dockerd.service", false],
    ["sshd.service", false],
    ["ssh.service", false],
    ["openship.service", false], // the control plane itself
    ["openship-dev.service", false], // NOT a deployment with id "dev"
    [undefined, false],
  ])("%s → %s", (unit, expected) => {
    expect(mayStopUnitForAppPort(unit)).toBe(expected);
  });
});

describe("mayStopUnitForEdgeTakeover — proxies allowed, daemons never", () => {
  test.each([
    // Replacing a bare-host OpenResty with the container edge IS the operation.
    ["openresty.service", true],
    ["nginx.service", true],
    ["apache2.service", true],
    ["haproxy.service", true],
    ["docker.service", false],
    ["snap.lxd.daemon.service", false],
    ["user@1000.service", false],
    ["sshd.service", false],
    ["openship.service", false],
    [undefined, false],
  ])("%s → %s", (unit, expected) => {
    expect(mayStopUnitForEdgeTakeover(unit)).toBe(expected);
  });
});

describe("containerIdFromCgroup", () => {
  const id = "a".repeat(64);
  test.each([
    [`0::/system.slice/docker-${id}.scope`, id], // cgroup v2, systemd driver
    [`11:name=systemd:/docker/${id}`, id], // cgroup v1 / cgroupfs
    [`0::/user.slice/user-1000.slice/user@1000.service/docker-${id}.scope`, id], // rootless
    ["0::/system.slice/docker.service", null], // dockerd itself, not a container
    ["0::/system.slice/openship-dep_x.service", null],
    ["", null],
    [null, null],
  ])("%s → %s", (cgroup, expected) => {
    expect(containerIdFromCgroup(cgroup)).toBe(expected);
  });
});

describe("ensurePortAvailable — the fixes the adversarial review found", () => {
  test("a refused port continues once the operator frees it by hand", async () => {
    // The recovery window HEAD had (via a mislabelled "Free Port & Continue" that freed
    // nothing and then re-probed). Losing it would throw away a built artifact for a
    // conflict clearable in a shell in ten seconds.
    let freedByHand = false;
    const host = recordingHost(() => [
      [`sport = :${PORT}`, freedByHand ? "" : SS_DOCKER_PROXY],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [`--filter publish=${PORT}`, null], // docker unaskable → ownership unproven
    ]);
    const { logger } = fakeLogger();
    const calls: PromptPayload[] = [];
    const promptUser: PromptUserFn = async (p) => {
      calls.push(p);
      freedByHand = true; // the operator stops it in another shell, then clicks
      return "re_check";
    };

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, promptUser),
    ).resolves.toBeUndefined();
    expect(calls[0]!.actions.map((a) => a.id)).toEqual(["re_check", "abort"]);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("Openship's OWN control-plane container is never a stop target", async () => {
    // `openship up` runs the api as a compose service on 4000. It carries no
    // openship.project label, so without the platform check it reads as an ordinary
    // foreign container and a deploy on 4000 would offer to stop the API serving it.
    const host = recordingHost(() => [
      ["sport = :4000", SS_DOCKER_PROXY.replace(`:${PORT}`, ":4000")],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY.replace(`${PORT}`, "4000")],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [
        "--filter publish=4000",
        psLine({ name: "openship-api-1", image: "ghcr.io/oblien/openship-api:latest" }),
      ],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(ensurePortAvailable(host.executor, 4000, logger, spy.promptUser)).rejects.toThrow(
      /Openship itself/,
    );
    expect(host.seen.some((c) => c.includes("docker stop"))).toBe(false);
    expect(spy.calls[0]!.details).toMatchObject({ platformContainer: true, stopTarget: "none" });
    // Asserting the MESSAGE, not just the details bag: the first version of this refusal
    // fell through to the docker-blind copy, which claimed Openship "couldn't identify"
    // a container it had just named and told the operator to `docker stop` it — the API
    // serving the deploy. Only a message assertion catches that.
    expect(spy.calls[0]!.message).toContain("openship-api-1");
    expect(spy.calls[0]!.message).not.toMatch(/couldn't identify/i);
    expect(spy.calls[0]!.message).not.toMatch(/docker ps --filter publish/);
  });

  test("the stack's stock-image postgres is recognized through its compose project", async () => {
    // postgres/redis run stock images under compose service names, so only the compose
    // project they share with the api marks them as the control plane's.
    const host = recordingHost(() => [
      [
        "--filter publish=5432",
        psLine({
          name: "openship-postgres-1",
          image: "postgres:16-alpine",
          composeProject: "openship",
        }),
      ],
      [
        "label=com.docker.compose.project='openship'",
        `${psLine({ name: "openship-api-1", image: "ghcr.io/oblien/openship-api:latest", composeProject: "openship" })}\n` +
          psLine({
            name: "openship-postgres-1",
            image: "postgres:16-alpine",
            composeProject: "openship",
          }),
      ],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(ensurePortAvailable(host.executor, 5432, logger, spy.promptUser)).rejects.toThrow(
      /Openship itself/,
    );
    expect(host.seen.some((c) => c.includes("docker stop"))).toBe(false);
    expect(spy.calls[0]!.details).toMatchObject({ platformContainer: true });
    expect(spy.calls[0]!.message).not.toMatch(/couldn't identify/i);
  });

  test("a container id off a cgroup with no name or image is refused, not stopped", async () => {
    // The edge/platform guards read a name or image. With neither — docker could not
    // describe the id — they cannot run, and a host-networked edge is invisible to the
    // publish filter, so stopping it blind is exactly the accident to avoid.
    const NGINX_PID = 991;
    const host = recordingHost(() => [
      [
        `sport = :${PORT}`,
        `LISTEN 0 511 0.0.0.0:${PORT} 0.0.0.0:* users:(("nginx",pid=${NGINX_PID},fd=8))`,
      ],
      [`-p ${NGINX_PID} -o args=`, "nginx: master process nginx -g daemon off;"],
      [`/proc/${NGINX_PID}/cgroup`, `0::/system.slice/docker-${CID}.scope`],
      [`--filter publish=${PORT}`, ""],
      [`--filter id='${CID}'`, null], // cannot describe it
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("free_port");

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).rejects.toThrow();
    expectRefusalPrompt(spy);
    // The id is reported so the operator can `docker inspect` it, and authorizes
    // nothing: the one rule refuses a container it cannot NAME.
    expect(spy.calls[0]!.details).toMatchObject({ containerId: CID, stopTarget: "none" });
    // Its copy names the id and points at `docker inspect` — not at `--filter publish`,
    // which is precisely what cannot see a host-networked container.
    expect(spy.calls[0]!.message).toContain(`docker inspect ${CID}`);
    expect(spy.calls[0]!.message).not.toMatch(/docker ps --filter publish/);
    expect(spy.calls[0]!.details!.containerName).toBeUndefined();
    expect(host.seen.some((c) => c.includes("docker stop"))).toBe(false);
    expect(forbiddenCommands(host.seen)).toEqual([]);
  });

  test("a publish match is NOT folded onto a genuine host listener", async () => {
    // `--filter publish=` is address-blind: mysqld on 10.0.0.5:8080 and a container
    // published on 127.0.0.1:8080 coexist. Overwriting the real listener with that
    // container names the wrong owner AND offers to stop it.
    const host = recordingHost(() => [
      [`sport = :${PORT}`, `LISTEN 0 511 10.0.0.5:${PORT} *:* users:(("mysqld",pid=800,fd=4))`],
      ["-p 800 -o args=", "/usr/sbin/mysqld --port=8080"],
      ["/proc/800/cgroup", "0::/system.slice/mysql.service"],
      ["--property=Description", "MySQL Community Server"],
      [`--filter publish=${PORT}`, psLine({ name: "somebody-redis", image: "redis:7" })],
    ]);
    const { logger } = fakeLogger();
    const spy = promptSpy("abort");

    await expect(
      ensurePortAvailable(host.executor, PORT, logger, spy.promptUser),
    ).rejects.toThrow();
    expect(spy.calls[0]!.details).toMatchObject({
      stopTarget: "unit",
      systemdUnit: "mysql.service",
    });
    expect(spy.calls[0]!.details!.containerName).toBeUndefined();
  });

  test("the container stop clears the restart policy first", async () => {
    // An explicit `docker stop` suppresses `restart: always` only until the daemon
    // restarts, so without this the container returns on reboot to fight for the port.
    let stopped = false;
    const host = recordingHost(() => [
      [`sport = :${PORT}`, stopped ? "" : SS_DOCKER_PROXY],
      [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      [`/proc/${PROXY_PID}/cgroup`, CGROUP_DOCKER_SERVICE],
      [`--filter publish=${PORT}`, stopped ? "" : OWNED_LINE],
    ]);
    const exec = host.executor.exec.bind(host.executor);
    (host.executor as { exec: typeof exec }).exec = async (cmd: string) => {
      const out = await exec(cmd);
      if (cmd.includes("docker stop")) stopped = true;
      return out;
    };
    const { logger } = fakeLogger();

    await ensurePortAvailable(host.executor, PORT, logger, promptSpy("free_port").promptUser);

    const update = host.seen.findIndex((c) => c.includes(`docker update --restart=no '${CID}'`));
    const stop = host.seen.findIndex((c) => c.includes(`docker stop '${CID}'`));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(update).toBeLessThan(stop);
  });
});

describe("portOccupantDetails — stopTarget is only stamped by whoever decided it", () => {
  test("omits stopTarget for the docker-blind cheap probe (the supervisors' path)", async () => {
    // A supervisor's EADDRINUSE occupant comes from probeListeningPort, which never asks
    // docker. Deriving a target there stamps "none" on every docker-published port, and
    // the operator-facing copy would promise no free action for exactly the case where a
    // redeploy offers a container stop.
    const occupant = await probeListeningPort(
      makeExecutor([
        [`sport = :${PORT}`, SS_DOCKER_PROXY],
        [`-p ${PROXY_PID} -o args=`, PS_DOCKER_PROXY],
      ]),
      PORT,
    );
    expect(occupant).toMatchObject({ dockerPublished: true });
    const details = portOccupantDetails(PORT, occupant);
    expect(details.stopTarget).toBeUndefined();
    expect(details).toMatchObject({ port: PORT, dockerPublished: true });
  });

  test("a null occupant degrades to just the port", () => {
    expect(portOccupantDetails(PORT, null)).toEqual({ port: PORT });
  });
});
