import { describe, expect, it, vi } from "vitest";

import { checkEdge } from "./checks";
import { uninstallEdge } from "./installer";
import type { CommandExecutor } from "../types";

function host(answers: Array<[string, string]>): CommandExecutor {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [needle, out] of answers) if (cmd.includes(needle)) return out;
      return "";
    }),
  } as unknown as CommandExecutor;
}

/** A kernel socket table with :80 (0x50) in LISTEN (0A) — what "serving" reads as. */
const PORT_80_LISTENING: [string, string] = [
  "/proc/net/tcp",
  "  0: 00000000:0050 00000000:0000 0A 00000000:00000000 0 0 1 1 ffff 100 0 0 10 0",
];
const EDGE_RUNNING: [string, string] = ["docker inspect", "running"];

describe("checkEdge", () => {
  it("reports healthy from the edge CONTAINER", async () => {
    // A converted box has no openresty binary, no unit and no Lua on the host, so
    // every host probe reads "missing" — the component would show broken while the
    // edge is serving fine.
    const status = await checkEdge(
      host([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        EDGE_RUNNING,
        PORT_80_LISTENING,
        ["openresty -v", "nginx version: openresty/1.27.1.1"],
      ]),
    );

    expect(status.healthy).toBe(true);
    expect(status.version).toBe("1.27.1.1");
  });

  it("flags an unresponsive edge container that is nonetheless serving :80", async () => {
    const status = await checkEdge(
      host([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        EDGE_RUNNING,
        PORT_80_LISTENING,
      ]),
    );

    expect(status.healthy).toBe(false);
    expect(status.message).toMatch(/docker logs openship-edge/);
  });

  // ── The bug this check existed to miss ──
  //
  // Docker keeps `.State.Running == true` across a restart loop, so a container
  // crash-looping on `bind() … Address already in use` appears in plain `docker ps`
  // AND answers `openresty -v` whenever the probe lands in the brief up-window
  // between restarts. This surface therefore rendered "edge 1.27.1.1 - running",
  // intermittently green, on a box whose edge had never bound :80 — which is how
  // "Fix edge" could report success while the home page kept its "Edge down" card.
  it("is NOT healthy for a crash-looping edge, even when it answers a version probe", async () => {
    const status = await checkEdge(
      host([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["docker inspect", "restarting"],
        ["openresty -v", "nginx version: openresty/1.27.1.1"],
        ["docker logs", "2026/08/04 nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)"],
      ]),
    );

    expect(status.healthy).toBe(false);
    expect(status.running).toBe(false);
    // The container's own [emerg] is the diagnosis — the operator can act on
    // "something else holds :80", not on "not responding".
    expect(status.message).toMatch(/Address already in use/);
  });

  it("is NOT healthy when the container is up but nothing is listening on :80", async () => {
    const status = await checkEdge(
      host([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        EDGE_RUNNING,
      ]),
    );

    expect(status.healthy).toBe(false);
    expect(status.message).toMatch(/nothing is listening on :80/);
  });

  // No container = no edge. There is no host fallback to probe any more: the edge
  // IS the image, so a box without it gets an install, not a second code path.
  it("reports missing when no container is running, even with a host openresty", async () => {
    const status = await checkEdge(
      host([
        ["openresty -v", "nginx version: openresty/1.25.3.1"],
        ["pgrep", "555"],
        ["site_logger.lua", "ok"],
      ]),
    );

    expect(status.healthy).toBe(false);
    expect(status.message).toMatch(/openship-edge container/);
  });

  it("reports missing on a box with neither, pointing at the container install", async () => {
    const status = await checkEdge(host([]));
    expect(status.healthy).toBe(false);
    expect(status.name).toBe("edge");
    expect(status.message).toMatch(/openship-edge container/);
  });
});

describe("uninstallEdge on a container edge", () => {
  it("removes the container and never pkills openresty on the host", async () => {
    // `pkill -f openresty` matches a HOST-NETWORKED container's own master process,
    // so the bare uninstall path would kill the edge it's supposed to be removing
    // cleanly — and then fail purging a package that was never installed.
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.startsWith("docker ps --filter name=openship-edge")) return "openship-edge";
      if (cmd.includes("id -u")) return "0";
      return "";
    });

    const result = await uninstallEdge(
      { exec, streamExec: vi.fn(async () => ({ code: 0, output: "" })) } as unknown as CommandExecutor,
      () => {},
    );

    expect(result.success).toBe(true);
    expect(cmds.some((c) => c.includes("docker rm -f 'openship-edge'"))).toBe(true);
    // Restart policy cleared first, or the daemon brings it right back.
    expect(cmds.some((c) => c.includes("docker update --restart=no"))).toBe(true);
    expect(cmds.some((c) => c.includes("pkill"))).toBe(false);
    expect(cmds.some((c) => c.includes("purge") || c.includes("systemctl stop openresty"))).toBe(false);
  });
});
