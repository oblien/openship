import { describe, expect, it, vi } from "vitest";

import { checkMailHealth } from "../../../src/modules/mail/mail-health.service";
import { parseMailUnitProbe } from "../../../src/modules/mail/mail-engine";
import type { CommandExecutor } from "@repo/adapters";

/**
 * Same defect class as #408: a probe that cannot reach its target must not report a
 * confident cause. Behind `2>/dev/null || true`, every docker-level failure came
 * back empty and was then reported as "missing" — "this daemon is not installed" —
 * for a box whose engine container was merely down. The state has to read
 * `unknown`, and it has to say why.
 *
 * Classification is pure (`parseMailUnitProbe`), so most of this needs no executor.
 */
describe("parseMailUnitProbe — container flavor", () => {
  const parse = (raw: string, key = "postfix", unit = "postfix") =>
    parseMailUnitProbe("container", key, unit, raw);

  it("reads supervisord state for a running daemon", () => {
    const state = parse("postfix                          RUNNING   pid 12, uptime 0:03:11");

    expect(state.status).toBe("active");
    expect(state.subState).toBe("running");
    expect(state.detail).toBeUndefined();
  });

  it("reports a genuinely absent program as missing", () => {
    const state = parse("fail2ban: ERROR (no such process)", "fail2ban", "fail2ban");

    expect(state.status).toBe("missing");
    expect(state.detail).toBeUndefined();
  });

  // The bug: engine container down → docker writes to stderr and exits non-zero,
  // `|| true` swallowed the code and `2>/dev/null` swallowed the words, so every
  // daemon read "missing".
  it("reports unknown with the reason when the engine container is gone", () => {
    const state = parse("Error response from daemon: No such container: openship-mail");

    expect(state.status).toBe("unknown");
    expect(state.detail).toContain("No such container: openship-mail");
  });

  it("reports unknown with the reason when the docker daemon is unreachable", () => {
    const state = parse("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");

    expect(state.status).toBe("unknown");
    expect(state.detail).toContain("Cannot connect to the Docker daemon");
  });

  it("reports unknown rather than missing when the probe produces nothing", () => {
    const state = parse("");

    expect(state.status).toBe("unknown");
    expect(state.detail).toBe("probe returned no output");
  });

  it("skips a supervisorctl banner line to find the state line", () => {
    const state = parse(
      "Unlinking stale socket /var/run/supervisor.sock\niredapd   FATAL     Exited too quickly",
      "iredapd",
      "iredapd",
    );

    expect(state.status).toBe("failed");
  });

  describe("postgresql sidecar", () => {
    const pg = (raw: string) => parseMailUnitProbe("container", "postgresql", "postgresql", raw);

    it("maps the running flag", () => {
      expect(pg("true").status).toBe("active");
      expect(pg("false").status).toBe("inactive");
    });

    it("reports missing only when docker says the container is not there", () => {
      expect(pg("Error: No such object: openship-mail-db").status).toBe("missing");
    });

    // Previously `|| echo missing` made this identical to an uninstalled sidecar,
    // and anything else non-"true" fell through to a confident "inactive".
    it("reports unknown with the reason when docker itself fails", () => {
      const state = pg("permission denied while trying to connect to the Docker daemon socket");

      expect(state.status).toBe("unknown");
      expect(state.detail).toContain("permission denied");
    });
  });
});

/**
 * The legacy host flavor has to hold the same line: systemd's own
 * "not-found" is a conclusion, an unreadable probe is not.
 */
describe("parseMailUnitProbe — host flavor", () => {
  const parse = (raw: string) => parseMailUnitProbe("host", "postfix", "postfix", raw);

  it("reads a loaded, active unit", () => {
    const state = parse(
      [
        "LoadState=loaded",
        "ActiveState=active",
        "SubState=running",
        "ActiveEnterTimestamp=Tue 2026-08-04 14:22:05 UTC",
      ].join("\n"),
    );

    expect(state.status).toBe("active");
    expect(state.subState).toBe("running");
    expect(state.activeSince).toBe("2026-08-04T14:22:05.000Z");
  });

  it("treats LoadState=not-found as missing", () => {
    expect(parse("LoadState=not-found\nActiveState=inactive").status).toBe("missing");
  });

  it("reports unknown with the reason when systemctl itself fails", () => {
    const state = parse("System has not been booted with systemd as init system");

    expect(state.status).toBe("unknown");
    expect(state.detail).toContain("not been booted with systemd");
  });

  it("drops an unparseable timestamp instead of emitting an invalid date", () => {
    const state = parse("LoadState=loaded\nActiveState=active\nActiveEnterTimestamp=n/a");

    expect(state.status).toBe("active");
    expect(state.activeSince).toBeUndefined();
  });
});

/** Detection answers first; `{{.Config.Image}}` is only in that probe's format. */
function engine(reply: (cmd: string) => string | Error, detect = "true\topenship/mail:latest") {
  return {
    exec: vi.fn(async (cmd: string) => {
      if (cmd.includes("{{.Config.Image}}")) return detect;
      const out = reply(cmd);
      if (out instanceof Error) throw out;
      return out;
    }),
  } as unknown as CommandExecutor;
}

const byKey = (rows: Awaited<ReturnType<typeof checkMailHealth>>, key: string) => {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no ${key} row`);
  return row;
};

describe("checkMailHealth", () => {
  it("carries a per-daemon reason through to the row", async () => {
    const rows = await checkMailHealth(
      engine((cmd) =>
        cmd.includes("supervisorctl")
          ? "Error response from daemon: No such container: openship-mail"
          : "",
      ),
    );

    expect(byKey(rows, "postfix").status).toBe("unknown");
    expect(byKey(rows, "postfix").detail).toContain("No such container");
  });

  it("surfaces a thrown probe error as the reason", async () => {
    const rows = await checkMailHealth(
      engine((cmd) =>
        cmd.includes("supervisorctl")
          ? new Error("Command timed out after 30000ms: docker exec openship-mail …")
          : "",
      ),
    );

    expect(byKey(rows, "clamav").status).toBe("unknown");
    expect(byKey(rows, "clamav").detail).toContain("timed out after 30000ms");
  });

  // No engine of either flavor is a CONCLUSION — "there is nothing here" — so it
  // must not read as nine failed probes.
  it("reports missing, not unknown, on a box with no mail engine at all", async () => {
    const rows = await checkMailHealth(engine(() => "", ""));

    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.status === "missing")).toBe(true);
    expect(rows.every((r) => r.detail === undefined)).toBe(true);
  });
});
