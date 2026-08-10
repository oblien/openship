import { describe, expect, it, vi } from "vitest";

import { systemCatalog } from "./catalog";
import { checkDocker } from "./checks";
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

describe("checkDocker", () => {
  it("reports healthy when the daemon names its version", async () => {
    const status = await checkDocker(box([[...VERSION], ["docker info", "29.7.1"]]));

    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.version).toBe("29.7.1");
  });

  // The #408 report, end to end: the daemon's own refusal reaches the component
  // message instead of being replaced by the static guess.
  it("surfaces the daemon's refusal in the message", async () => {
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
    expect(status.running).toBe(false);
    // Still installed, at the version we parsed — the daemon is the only unknown.
    expect(status.installed).toBe(true);
    expect(status.version).toBe("29.7.1");
    expect(status.message).toContain("the daemon is not running");
    expect(status.message).toContain("permission denied");
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
  });

  it("probes for a server version, not just an exit code", () => {
    // Guards the false-positive direction: an exit-code-only probe reports healthy
    // for a daemon that answered nothing. See the comment on daemonCommand.
    expect(systemCatalog.checks.docker.daemonCommand).toContain("ServerVersion");
  });
});
