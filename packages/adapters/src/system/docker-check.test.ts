import { describe, expect, it, vi } from "vitest";

import { systemCatalog } from "./catalog";
import { checkDocker, needsDockerGroupRefresh } from "./checks";
import type { CommandExecutor } from "../types";

/**
 * #408: an SSH-added server reported "Docker is installed but the daemon is not
 * running" while `docker info` worked from the Terminal tab on the same
 * connection. The check had already READ the daemon's refusal off stderr and then
 * dropped it, so the report could only be a guess — hence a fix attempt (PR #422)
 * aimed at SSH quoting, which is not how ssh2's exec channel works.
 *
 * These pin the behaviour that makes the class of bug self-diagnosing: a probe
 * that fails explains itself, and a probe that exits 0 with nothing is still a
 * failure.
 */
function box(answers: Array<[string, string | Error]>): CommandExecutor {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [needle, out] of answers) {
        if (!cmd.includes(needle)) continue;
        if (out instanceof Error) throw out;
        return out;
      }
      return "";
    }),
  } as unknown as CommandExecutor;
}

const VERSION = ["docker --version", "Docker version 29.7.1, build abc1234"] as const;

describe("stale Docker login groups", () => {
  const denied = async () => checkDocker(box([
    [...VERSION], ["docker info", new Error("permission denied at /var/run/docker.sock")],
  ]));

  it("detects a newly granted supplementary group", async () => {
    expect(await needsDockerGroupRefresh(box([["id -G", "1000 100\n1000 100 999\n"]]), [await denied()])).toBe(true);
  });

  it("does not reconnect just because group order differs", async () => {
    expect(await needsDockerGroupRefresh(box([["id -G", "1000 999\n999 1000\n"]]), [await denied()])).toBe(false);
  });

  it.each(["", "1000\n", "1000\npermission denied", "1000\n1000\nextra", new Error("id failed")])(
    "does not infer changed groups from an unsuccessful probe: %s", async (answer) => {
      expect(await needsDockerGroupRefresh(box([["id -G", answer]]), [await denied()])).toBe(false);
    },
  );

  it("does not probe groups for a healthy or stopped daemon", async () => {
    const executor = box([]);
    const healthy = await checkDocker(box([[...VERSION], ["docker info", "29.7.1"]]));
    const stopped = await checkDocker(box([[...VERSION], ["docker info", new Error("Cannot connect to the Docker daemon")]]));
    expect(await needsDockerGroupRefresh(executor, [healthy])).toBe(false);
    expect(await needsDockerGroupRefresh(executor, [stopped])).toBe(false);
    expect(executor.exec).not.toHaveBeenCalled();
  });
});

describe("checkDocker", () => {
  it("reports healthy when the daemon names its version", async () => {
    const status = await checkDocker(box([[...VERSION], ["docker info", "29.7.1"]]));

    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.version).toBe("29.7.1");
  });

  // The #408 report, end to end: the daemon's own refusal reaches the component
  // message instead of being replaced by the static guess.
  //
  // And the headline matches the refusal. This case used to be reported as "the daemon
  // is not running", which is a different fault with a different fix — the operator was
  // sent to start a daemon that a socket permission had never let us ask about.
  it("names a socket refusal as a permission problem, not a stopped daemon", async () => {
    const status = await checkDocker(
      box([
        [...VERSION],
        [
          "docker info",
          new Error(
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
          ),
        ],
      ]),
    );

    expect(status.healthy).toBe(false);
    // Still installed, at the version we parsed — the daemon is the only unknown.
    expect(status.installed).toBe(true);
    expect(status.version).toBe("29.7.1");
    expect(status.message).toContain("not allowed to use its socket");
    expect(status.message).toContain("`docker` group");
    // The #408 property itself: the daemon's own words, still carried.
    expect(status.message).toContain("permission denied");
    expect(status.message).not.toContain("the daemon is not running");
    // Unknown, not false: a refusal is equally consistent with a healthy daemon, and
    // the point of this arm is to stop asserting things the probe didn't establish.
    expect(status.running).toBeUndefined();
  });

  // The other live #408 candidate: `docker --version` is client-only and instant,
  // `docker info` contacts the daemon and can outrun the 10s probe timeout. Same
  // symptom, completely different fix — so the message has to distinguish them.
  it("surfaces a probe timeout rather than blaming the daemon", async () => {
    const status = await checkDocker(
      box([
        [...VERSION],
        [
          "docker info",
          new Error("Command timed out after 10000ms: docker info --format '{{.ServerVersion}}'"),
        ],
      ]),
    );

    expect(status.healthy).toBe(false);
    expect(status.message).toMatch(/timed out after 10000ms/);
  });

  // Exit 0 with no server version is NOT healthy. This is what an exit-status-only
  // probe (`docker info >/dev/null && echo ok`) would misreport as running.
  it("treats an exit-0 probe with no server version as not running", async () => {
    const status = await checkDocker(box([[...VERSION], ["docker info", "   "]]));

    expect(status.healthy).toBe(false);
    expect(status.running).toBe(false);
    // Nothing failed, so there is no reason to append — no dangling separator.
    expect(status.message).toBe(systemCatalog.checks.docker.notRunningMessage);
  });

  it("explains a failing version probe instead of a bare 'not installed'", async () => {
    const status = await checkDocker(
      box([["docker --version", new Error("sh: 1: docker: not found")]]),
    );

    expect(status.installed).toBe(false);
    expect(status.message).toContain("Docker is not installed");
    expect(status.message).toContain("docker: not found");
  });

  it("collapses a multi-line failure to its first line", async () => {
    const status = await checkDocker(
      box([
        [...VERSION],
        [
          "docker info",
          new Error("Cannot connect to the Docker daemon\nIs the docker daemon running?"),
        ],
      ]),
    );

    expect(status.message).toContain("Cannot connect to the Docker daemon");
    expect(status.message).not.toContain("Is the docker daemon running?");
    expect(status.message.split("\n")).toHaveLength(1);
    // The other side of the permission discriminator, and the reason it is narrow: this
    // IS a stopped daemon, so it must keep the stopped headline and the `false` that
    // goes with it. A looser match on the word "docker" would hand this arm the
    // group-membership remedy, which fixes nothing here.
    expect(status.message).toContain(systemCatalog.checks.docker.notRunningMessage!);
    expect(status.running).toBe(false);
  });

  it("probes for a server version, not just an exit code", () => {
    // Guards the false-positive direction: an exit-code-only probe reports healthy
    // for a daemon that answered nothing. See the comment on daemonCommand.
    expect(systemCatalog.checks.docker.daemonCommand).toContain("ServerVersion");
  });

  // Rootless-podman servers speak docker-compat, not Docker: the first format
  // expression exits 125 with no output, which without the fallback below read
  // as "daemon not running" and froze job dispatch for hours (the probe is what
  // the actions dispatcher trusts). Both engines must be able to answer.
  it("falls back to Podman's server version field", () => {
    const command = systemCatalog.checks.docker.daemonCommand!;
    expect(command).toContain("docker info --format '{{.Version.Version}}'");
    // The Docker branch's stderr is silenced so a podman template error cannot
    // become the reported failure text; the fallback branch keeps its own.
    expect(command).toMatch(/\{\{\.ServerVersion\}\}' 2>\/dev\/null \|\|/);
  });

  it("reports healthy when only the Podman field answers", async () => {
    // The shell on the host picks the branch; here the executor answers for the
    // fallback expression exactly as podman's compat CLI would.
    const status = await checkDocker(
      box([
        [...VERSION],
        ["docker info --format '{{.Version.Version}}'", "5.8.2"],
      ]),
    );

    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    // The daemon's answer outranks the CLI's --version line: what's RUNNING is
    // 5.8.2, and the CLI version (29.7.1) is a different engine's number.
    expect(status.version).toBe("5.8.2");
  });
});

// ── Engine naming ────────────────────────────────────────────────────────────
//
// The component is named "docker", but the ENGINE behind it is what the
// operator drives: on a podman host every "docker …" message sends them to a
// tool that was never installed. checkDocker therefore names what it found
// (system/engine.ts) in the status message, and carries it on the status.
describe("checkDocker names the engine it finds", () => {
  // The podman-docker shim execs `podman`, so `docker --version` itself prints
  // "podman version …" — the shim short-circuits detection, no extra probe.
  it("reports a shim host as podman running", async () => {
    const status = await checkDocker(box([
      ["docker --version", "podman version 5.8.2"],
      ["docker info --format '{{.Version.Version}}'", "5.8.2"],
    ]));

    expect(status.engine).toBe("podman");
    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.version).toBe("5.8.2");
    expect(status.message).toBe("podman 5.8.2 - running");
  });

  // A REAL docker CLI pointed at Podman's socket: the daemon's section names
  // Podman even though `docker --version` said Docker.
  it("believes the daemon's section over the CLI's version line", async () => {
    const status = await checkDocker(box([
      [...VERSION],
      ["docker info", "5.8.2"],
      ["docker version", "Client: Docker Engine - Community\n Version: 29.7.1\n\nServer:       Podman Engine\nVersion:      5.8.2"],
    ]));

    expect(status.engine).toBe("podman");
    // Review finding on #11: the message must not pair Podman's NAME with the
    // docker CLI's VERSION ("podman 29.7.1 - running") — the daemon probe's
    // answer is the version that is actually running.
    expect(status.version).toBe("5.8.2");
    expect(status.message).toBe("podman 5.8.2 - running");
    expect(status.message).not.toContain("29.7.1");
  });

  it("names a real dockerd as docker, same words as before", async () => {
    const status = await checkDocker(box([
      [...VERSION],
      ["docker info", "29.7.1"],
      ["docker version", "Client: Docker Engine - Community\n Version: 29.7.1\n\nServer: Docker Engine - Community\n  Engine:\n   Version: 29.7.1"],
    ]));

    expect(status.engine).toBe("docker");
    expect(status.message).toBe("docker 29.7.1 - running");
  });

  // A podman-only box (no docker CLI at all): "Docker is not installed" would
  // send the operator to install the wrong thing.
  it("points a podman-only host at the docker shim instead of Docker", async () => {
    const status = await checkDocker(box([
      ["docker --version", new Error("sh: 1: docker: not found")],
      ["docker version", "sh: 1: docker: not found"],
      ["podman --version", "podman version 6.0.2"],
    ]));

    expect(status.engine).toBe("podman");
    expect(status.healthy).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.message).toContain("podman is installed, but this server has no docker CLI");
  });

  it("gives a denied podman host the socket-group remedy, not the docker group", async () => {
    const status = await checkDocker(box([
      ["docker --version", "podman version 5.8.2"],
      ["docker info", new Error("permission denied at /var/run/docker.sock")],
    ]));

    expect(status.engine).toBe("podman");
    expect(status.message).toContain("Podman is installed but this connection is not allowed");
    expect(status.message).toContain("socket's group");
    expect(status.message).not.toContain("`docker` group");
  });

  it("keeps docker wording when nothing classifies (the old behaviour)", async () => {
    // Both detection probes answer nothing: the wording must not regress.
    const status = await checkDocker(box([
      [...VERSION],
      ["docker info", "29.7.1"],
    ]));

    expect(status.engine).toBeUndefined();
    expect(status.message).toBe("docker 29.7.1 - running");
  });
});
