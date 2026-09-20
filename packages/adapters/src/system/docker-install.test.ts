import { describe, expect, it, vi } from "vitest";

import { MIN_DOCKER_VERSION } from "./catalog";
import { OS_RELEASE, probeOutput } from "./environment.fixtures";
import { installDocker } from "./installer";
import type { CommandExecutor } from "../types";

/**
 * #491: "Ensure System Components" ran `curl -fsSL https://get.docker.com | sh`
 * unconditionally — on a box already running Docker, and running Openship itself
 * under it. Two ways that hurt, both reported from the same host:
 *
 *   - held packages (`apt-mark hold docker-ce …`) → apt refused, and the only thing
 *     the UI said was "Docker install failed: Docker install failed"
 *   - no holds → a silent major engine upgrade (28.x → 29.x + containerd), whose
 *     daemon restart bounced every container on the server
 *
 * These pin the three fixes: skip a working Docker, never upgrade one implicitly,
 * and repeat apt's own diagnosis instead of a generic string.
 */

type Answer = [string, string | Error];

interface Box {
  executor: CommandExecutor;
  /** Commands run through streamExec — installs, service starts. */
  ran: string[];
  /** Commands run through exec — probes, verifies. */
  execed: string[];
}

function box(
  answers: Answer[],
  onStream?: (cmd: string) => { code: number; output: string },
): Box {
  const ran: string[] = [];
  const execed: string[] = [];
  // `answers` is read live, so a stream handler can flip an answer to model a
  // command that changes the box (systemctl start docker).
  const answer = (cmd: string) => {
    for (const [needle, out] of answers) {
      if (!cmd.includes(needle)) continue;
      if (out instanceof Error) throw out;
      return out;
    }
    return "";
  };
  const executor = {
    exec: vi.fn(async (cmd: string) => {
      execed.push(cmd);
      return answer(cmd);
    }),
    streamExec: vi.fn(async (cmd: string) => {
      ran.push(cmd);
      return onStream?.(cmd) ?? { code: 0, output: "" };
    }),
  } as unknown as CommandExecutor;
  return { executor, ran, execed };
}

/**
 * An Ubuntu box we log into as root — the reporter's environment.
 *
 * One answer, because detection is one round-trip: the whole host is whatever the probe
 * script printed. It has to be matched ahead of everything else, since the script's own
 * text contains `uname -s`, `id -u` and `command -v` lines that a narrower needle would
 * otherwise capture — leaving the profile reading as an sshd interception.
 */
const HOST: Answer[] = [["opsh_begin", probeOutput({ osRelease: OS_RELEASE.ubuntu2404 })]];

const CURRENT: Answer[] = [
  ["docker --version", "Docker version 28.3.2, build abc1234"],
  ["docker info", "28.3.2"],
];

const noop = () => {};
const installed = (b: Box) => b.ran.some((cmd) => cmd.includes("get.docker.com"));

describe("installDocker", () => {
  it("leaves a working, current Docker alone", async () => {
    const b = box([...CURRENT, ...HOST]);

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(true);
    expect(result.version).toBe("28.3.2");
    expect(installed(b)).toBe(false);
    expect(b.ran).toEqual([]);
  });

  // The skip happens before `prepareExecutor`, so a box that needs no install is
  // never told it needs root — and never has its privilege probed at all.
  it("skips without needing root", async () => {
    const b = box([...CURRENT, ...HOST.filter(([n]) => n !== "id -u"), ["id -u", "1000"]]);

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(true);
    expect(b.execed.some((cmd) => cmd.includes("sudo -n"))).toBe(false);
  });

  it("refuses to upgrade an engine below the floor, and says so", async () => {
    const b = box([
      ["docker --version", "Docker version 19.03.15, build 99e3ed8"],
      ["docker info", "19.03.15"],
      ...HOST,
    ]);

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(false);
    expect(result.version).toBe("19.03.15");
    expect(result.error).toContain(MIN_DOCKER_VERSION);
    // The reason it stops rather than upgrading has to be IN the message: the
    // operator is the one who decides to take every container down.
    expect(result.error).toMatch(/restarts the daemon and every container/i);
    expect(installed(b)).toBe(false);
  });

  it("starts a stopped daemon instead of reinstalling over it", async () => {
    const answers: Answer[] = [
      ["docker --version", "Docker version 28.3.2, build abc1234"],
      ["docker info", new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")],
      ...HOST,
    ];
    const b = box(answers, (cmd) => {
      if (cmd.includes("enable --now 'docker'")) answers[1] = ["docker info", "28.3.2"];
      return { code: 0, output: "" };
    });

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(true);
    expect(result.version).toBe("28.3.2");
    // The start command comes from the host profile, not a literal here: this box is
    // Ubuntu/systemd, and `--now` so a daemon that was also DISABLED comes back after
    // the next reboot rather than needing this same repair again.
    expect(b.ran).toEqual(["systemctl enable --now 'docker'"]);
    expect(installed(b)).toBe(false);
  });

  it("reports a daemon it could not start, without reinstalling", async () => {
    const b = box([
      ["docker --version", "Docker version 28.3.2, build abc1234"],
      ["docker info", new Error("permission denied while trying to connect to the Docker daemon socket")],
      ...HOST,
    ]);

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(false);
    // The daemon's own words survive to the caller (see docker-check.test.ts).
    expect(result.error).toContain("permission denied");
    expect(installed(b)).toBe(false);
  });

  it("installs when Docker is genuinely missing", async () => {
    const b = box([
      ["docker --version", new Error("sh: 1: docker: not found")],
      ...HOST,
    ]);
    // Post-install the box has Docker; the verify runs `docker --version` again.
    (b.executor.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes("docker --version")) {
        if (!installed(b)) throw new Error("sh: 1: docker: not found");
        return "Docker version 29.7.1, build def5678";
      }
      for (const [needle, out] of HOST) if (cmd.includes(needle)) return out as string;
      return "";
    });

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(true);
    expect(result.version).toBe("29.7.1");
    expect(installed(b)).toBe(true);
  });

  // The reporter's failure, verbatim: apt's refusal is the whole diagnosis and it
  // used to reach exactly nowhere.
  it("surfaces apt's held-package refusal", async () => {
    const b = box(
      [["docker --version", new Error("sh: 1: docker: not found")], ...HOST],
      (cmd) =>
        cmd.includes("get.docker.com")
          ? {
              code: 100,
              output: [
                "Reading package lists...",
                "Building dependency tree...",
                "E: Held packages were changed and -y was used without --allow-change-held-packages",
              ].join("\n"),
            }
          : { code: 0, output: "" },
    );

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Held packages were changed");
    expect(result.error).toContain("exit 100");
    // A hold is a decision — name it, and say Openship won't override it.
    expect(result.error).toMatch(/apt-mark hold/);
    // Never the doubled generic string the issue reported.
    expect(result.error).not.toBe("Docker install failed");
  });

  it("runs the installer over a working Docker only when explicitly asked", async () => {
    const b = box([...CURRENT, ...HOST]);

    const result = await installDocker(b.executor, noop, { reinstall: true });

    expect(result.success).toBe(true);
    expect(installed(b)).toBe(true);
  });

  it("warns that a forced reinstall restarts every container", async () => {
    const b = box([...CURRENT, ...HOST]);
    const logs: string[] = [];

    await installDocker(b.executor, (entry) => logs.push(`${entry.level}:${entry.message}`), {
      reinstall: true,
    });

    expect(logs.some((line) => line.startsWith("warn:") && /every container/i.test(line))).toBe(true);
  });
});

/**
 * The commands are chosen by `envOps` from the profile, and `environment-ops.test.ts`
 * pins them per distro. What these pin is the WIRING: that `installDocker` runs the
 * host's own install command, and then its own start command — which is where the
 * reported failure lived. `get.docker.com` hard-refuses `amzn` and `alpine`, and the
 * start table only knew systemd, so a non-Debian box got an install that did nothing
 * followed by a start that was skipped, and the first sign of it was the Docker-over-SSH
 * bridge reporting `socket hang up`.
 */
describe("installDocker on a host get.docker.com refuses", () => {
  const missing: Answer = ["docker --version", new Error("docker: not found")];
  const ranOn = async (osRelease: string, spec?: Parameters<typeof probeOutput>[0]) => {
    const b = box([missing, ["opsh_begin", probeOutput({ osRelease, ...spec })]]);
    await installDocker(b.executor, noop);
    return b.ran;
  };

  it("installs Amazon Linux 2023 from dnf, never from the convenience script", async () => {
    const ran = await ranOn(OS_RELEASE.amzn2023, { pm: "dnf" });

    expect(ran.some((cmd) => cmd.includes("dnf install -y docker"))).toBe(true);
    expect(ran.some((cmd) => cmd.includes("get.docker.com"))).toBe(false);
    expect(ran).toContain("systemctl enable --now 'docker'");
  });

  it("installs Alpine from apk AND starts it through openrc", async () => {
    const ran = await ranOn(OS_RELEASE.alpine320, { pm: "apk", sm: "openrc", libc: "musl" });

    expect(ran.some((cmd) => cmd.includes("apk add"))).toBe(true);
    // Two steps, and the daemon is the second one — the half that used to be dropped.
    expect(ran).toContain("rc-update add 'docker' default && rc-service 'docker' start");
  });

  it("refuses an unsupported host before it tries to elevate on it", async () => {
    // The verdict is checked first now. It used to be reached only after `sudo -n true`
    // succeeded, so a non-root openSUSE box failed with "requires root or passwordless
    // sudo" — a fixable-sounding problem that isn't the actual one, and an operator who
    // fixes it arrives at the same wall from further away.
    const b = box([missing, ["opsh_begin", probeOutput({ osRelease: OS_RELEASE.opensuse156, pm: "none", uid: "1000", user: "dev", sudo: "n" })]]);

    const result = await installDocker(b.executor, noop);

    expect(result.success).toBe(false);
    expect(result.error).toContain("opensuse-leap");
    expect(result.error).not.toMatch(/passwordless sudo/i);
    expect(b.ran).toEqual([]);
  });
});
