import { describe, expect, it } from "vitest";
import { answered, refused, type Answer, type EnvironmentProfile } from "@repo/core";

import { parseEnvironmentProbe } from "./environment";
import { envOps, opScript, type EnvOps, type HostCommands } from "./environment-ops";
import {
  answeredProbe,
  interceptedProbe,
  unansweredProbe,
  OS_RELEASE,
  type ProbeSpec,
} from "./environment.fixtures";

/**
 * A host built by the real parser from what the real script would print.
 *
 * Not a hand-written profile literal: the bug this module exists to prevent lived in the
 * gap between what the detector produced and what a call site assumed, so a fixture that
 * skips the parser can't see it. Here a test says "an Amazon Linux 2023 box" and the
 * profile is whatever the shipped classification makes of that.
 */
function host(spec: ProbeSpec): EnvironmentProfile {
  return parseEnvironmentProbe(answeredProbe(spec));
}

const HOSTS = {
  ubuntu2404: host({ osRelease: OS_RELEASE.ubuntu2404, fw: "ufw" }),
  debian12: host({ osRelease: OS_RELEASE.debian12 }),
  amzn2023: host({ osRelease: OS_RELEASE.amzn2023, pm: "dnf", selinux: "enforcing" }),
  amzn2: host({ osRelease: OS_RELEASE.amzn2, pm: "yum" }),
  rocky9: host({ osRelease: OS_RELEASE.rocky9, pm: "dnf", fw: "firewalld" }),
  alma9: host({ osRelease: OS_RELEASE.alma9, pm: "dnf", fw: "firewalld" }),
  oracle9: host({ osRelease: OS_RELEASE.oracle9, pm: "dnf" }),
  rhel9: host({ osRelease: OS_RELEASE.rhel9, pm: "dnf", fw: "firewalld" }),
  fedora40: host({ osRelease: OS_RELEASE.fedora40, pm: "dnf", fw: "firewalld" }),
  centos7: host({ osRelease: OS_RELEASE.centos7, pm: "yum" }),
  alpine320: host({ osRelease: OS_RELEASE.alpine320, pm: "apk", sm: "openrc", libc: "musl" }),
  mint213: host({ osRelease: OS_RELEASE.mint213, fw: "ufw" }),
  popos2204: host({ osRelease: OS_RELEASE.popos2204 }),
  /** Refused by name. Nothing here may emit zypper. */
  opensuse156: host({ osRelease: OS_RELEASE.opensuse156, pm: "none" }),
  /** Refused by name. Nothing here may emit pacman. */
  arch: host({ osRelease: OS_RELEASE.arch, pm: "none" }),
  /**
   * An ID nobody knows, with a package manager that works — and therefore DRIVEN.
   *
   * Refusing this was the origin bug with the sign flipped: `amzn` fell through to an
   * unknown family, and the next unlisted RHEL/Debian rebuild must not be turned away
   * over a name. Every verb here answers off what was probed rather than off the family,
   * so this fixture is the one that would expose a half-wired answer if one appeared.
   */
  mystery: host({ osRelease: OS_RELEASE.mystery }),
  /** The same unplaceable ID with nothing to install with — refused, quoting the ID. */
  mysteryNoPm: host({ osRelease: OS_RELEASE.mystery, pm: "none" }),
  unknownArch: host({ arch: "riscv64" }),
  /** Supported distro, no init — `systemctl` present in the image, no systemd running. */
  initless: host({ sm: "none", container: "y" }),
  nftables: host({ fw: "nftables" }),
  rawIptables: host({ fw: "iptables" }),
  macos: host({
    os: "Darwin",
    osRelease: null,
    pm: "brew",
    sm: "launchd",
    uid: "501",
    user: "dev",
    home: "/Users/dev",
    sudo: "y",
    fw: "unknown",
  }),
  /** Supported (macOS needs no distro) but with nothing to install packages with. */
  macosNoBrew: host({
    os: "Darwin",
    osRelease: null,
    pm: "none",
    sm: "launchd",
    uid: "501",
    user: "dev",
    home: "/Users/dev",
    fw: "unknown",
  }),
  /** The origin bug: the AWS AMI's forced command answered instead of the probe. */
  forcedCommand: parseEnvironmentProbe(
    interceptedProbe('Please login as the user "ec2-user" rather than the user "root".'),
  ),
  /** A box we never measured at all — refused for a different reason than the above. */
  unmeasured: parseEnvironmentProbe(
    unansweredProbe("command timed out after 20000ms: sh -lc '…'"),
  ),
} satisfies Record<string, EnvironmentProfile>;

type HostName = keyof typeof HOSTS;
const HOST_NAMES = Object.keys(HOSTS) as HostName[];

const UNSUPPORTED: readonly HostName[] = [
  "opensuse156",
  "arch",
  "mysteryNoPm",
  "unknownArch",
  "forcedCommand",
  "unmeasured",
];

/**
 * One representative call per command, total over {@link HostCommands}.
 *
 * `Record<keyof HostCommands, …>` and not an array: adding a method without exercising it
 * here is TS2741, so the totality property below cannot fall behind the surface it
 * claims to cover. That is the whole reason this table is shaped the way it is.
 */
const CALLS: Readonly<Record<keyof HostCommands, (ops: EnvOps) => Answer<unknown>>> = {
  pkgInstall: (ops) => ops.pkgInstall(["git", "rsync"]),
  // Python is the real divergence: three package names on apt, two on dnf, and a name
  // Openship hasn't picked on apk. The refusal is part of the fixture.
  pkgInstallVariants: (ops) =>
    ops.pkgInstallVariants({
      apt: answered(["python3", "python3-pip", "python3-venv"]),
      dnf: answered(["python3", "python3-pip"]),
      yum: answered(["python3", "python3-pip"]),
      apk: refused("Openship has no apk package set for Python."),
      brew: answered(["python@3.12"]),
    }),
  pkgRemove: (ops) => ops.pkgRemove(["rsync"]),
  pkgAvailableVersion: (ops) => ops.pkgAvailableVersion("git"),
  serviceEnableStart: (ops) => ops.serviceEnableStart("openship-api"),
  serviceIsActive: (ops) => ops.serviceIsActive("docker"),
  firewallAllow: (ops) =>
    ops.firewallAllow({ cidrs: ["172.16.0.0/12"], port: 2222, proto: "tcp" }),
  dockerInstall: (ops) => ops.dockerInstall(),
  dockerStart: (ops) => ops.dockerStart(),
  releaseArch: (ops) => ops.releaseArch(),
};

const COMMANDS = Object.keys(CALLS) as (keyof HostCommands)[];

/** Every command's answer on one host, for the sweeps that don't care which is which. */
function allAnswers(profile: EnvironmentProfile): Answer<unknown>[] {
  const ops = envOps(profile);
  return COMMANDS.map((name) => CALLS[name](ops));
}

function steps(answer: Answer<unknown>): readonly string[] {
  if (!answer.supported) throw new Error(`expected commands, got refusal: ${answer.reason}`);
  return answer.value as readonly string[];
}

const CASES = HOST_NAMES.flatMap((hostName) =>
  COMMANDS.map((command) => ({ hostName, command })),
);

/** The refusal itself, with the `(host: …)` label envOps appends stripped off. */
function withoutHostSuffix(reason: string): string {
  return reason.replace(/\s*\(host:[^)]*\)\s*$/, "").trim();
}

describe("envOps totality", () => {
  /**
   * The property that makes "never a silent skip" mechanically true, per distro, forever.
   *
   * Before this, an unrecognized host produced `undefined` from a `Record<string, T>`
   * lookup and every call site read that as "nothing to do here" — which is how a box
   * finished provisioning with no dockerd and no error anywhere. There is no third shape
   * to read that way now, and this asserts it for every host × every command.
   */
  it.each(CASES)("$hostName · $command answers with commands or a reason", ({ hostName, command }) => {
    const answer = CALLS[command](envOps(HOSTS[hostName]));

    if (answer.supported) {
      expect(answer).not.toHaveProperty("reason");
      const value = answer.value;
      if (Array.isArray(value)) {
        expect(value.length).toBeGreaterThan(0);
        for (const step of value) {
          expect(typeof step).toBe("string");
          expect(step.trim()).not.toBe("");
        }
      } else {
        expect(typeof value).toBe("string");
        expect(value).not.toBe("");
      }
      return;
    }

    expect(answer).not.toHaveProperty("value");
    // A refusal an operator can't act on is the same dead end as a silent skip, just
    // louder — so a bare "unsupported" fails here.
    //
    // Measured WITHOUT the `(host: …)` suffix envOps appends. With it, every refusal
    // clears any sane floor on the strength of the host label alone, and the assertion
    // could not fail — a literal `reason: "no"` would have passed.
    expect(withoutHostSuffix(answer.reason).length).toBeGreaterThan(30);
  });

  it.each(CASES)("$hostName · $command names the host when it refuses", ({ hostName, command }) => {
    const ops = envOps(HOSTS[hostName]);
    const answer = CALLS[command](ops);
    if (answer.supported) return;
    expect(answer.reason).toContain(ops.describe());
  });
});

describe("envOps gating", () => {
  it.each(UNSUPPORTED)("refuses every command on %s, with the detector's reason", (hostName) => {
    const profile = HOSTS[hostName];
    expect(profile.supported).toBe(false);
    const reason = profile.unsupportedReason ?? "";
    expect(reason).not.toBe("");

    for (const answer of allAnswers(profile)) {
      expect(answer.supported).toBe(false);
      // One gate, so the reason is the detector's — not a second opinion invented per
      // method, which is what "the distro gate skipped it" used to look like.
      if (!answer.supported) expect(answer.reason).toContain(reason);
    }
  });

  /**
   * A family we cannot NAME is not a host we cannot DRIVE — provided something probed.
   *
   * The origin bug was `amzn` falling through to an unknown family and being silently
   * skipped. Refusing the whole host instead would fail the next unlisted rebuild just as
   * hard, so the gate is the package manager. What genuinely varies by family then has to
   * refuse for itself, per method, which is what the second half pins: `dockerInstall` has
   * no path here and says so, naming the ID, rather than reaching for `get.docker.com`
   * (which refuses these IDs anyway) or a family's repo layout on a guess.
   */
  it("drives an unplaceable distro that has a working package manager", () => {
    const ops = envOps(HOSTS.mystery);
    expect(HOSTS.mystery.distroFamily).toBe("unknown");
    expect(HOSTS.mystery.supported).toBe(true);
    expect(steps(ops.pkgInstall(["git"]))).toEqual([
      "apt-get update -qq",
      "apt-get install -y -qq git",
    ]);
    expect(steps(ops.serviceEnableStart("docker"))).toEqual(["systemctl enable --now 'docker'"]);

    const docker = ops.dockerInstall();
    expect(docker.supported).toBe(false);
    if (!docker.supported) expect(docker.reason).toContain("frobnicate");
  });

  it("refuses the same distro once nothing can install packages, quoting the ID", () => {
    const reason = HOSTS.mysteryNoPm.unsupportedReason ?? "";
    expect(HOSTS.mysteryNoPm.supported).toBe(false);
    expect(reason).toContain("frobnicate");
    expect(reason).toMatch(/apt-get, dnf, yum or apk/);
  });

  it("still answers facts about a host it refuses to drive", () => {
    // The refusal message is built out of these, so gating them would make the failure
    // unexplainable — and `home`/`stateDir` stay true whatever the verdict.
    const ops = envOps(HOSTS.opensuse156);
    expect(ops.describe()).toContain("openSUSE Leap 15.6");
    expect(ops.home()).toBe("/root");
    expect(ops.stateDir()).toBe("/root/.openship");
    expect(ops.sshdEnableHint()).toContain("sshd");
  });

  it("emits no zypper or pacman anywhere, on any host", () => {
    // The distros we refuse are refused *specifically* — naming zypper in the reason is
    // the point. What must never happen is a command that runs it, on any host: that is
    // exactly the "half-wired new distro" shape the two-arm type exists to prevent.
    for (const hostName of HOST_NAMES) {
      for (const answer of allAnswers(HOSTS[hostName])) {
        if (!answer.supported) continue;
        const text = Array.isArray(answer.value) ? answer.value.join(" ") : String(answer.value);
        expect(text).not.toMatch(/\bzypper\b|\bpacman\b/);
      }
    }
  });
});

/**
 * The manual Compose v2 install, for the arms whose repos carry no plugin package.
 *
 * Spelled out here rather than pattern-matched: the asset name is `x86_64`/`aarch64` (Docker
 * names its releases after `uname -m`) while every other artifact in this repo is
 * `amd64`/`arm64`, and a test that only looked for "docker-compose" would pass on the wrong
 * one — which downloads, chmods, and then won't execute.
 */
function composePluginSteps(asset: "x86_64" | "aarch64"): readonly string[] {
  return [
    "mkdir -p /usr/local/lib/docker/cli-plugins",
    `curl -fsSL https://github.com/docker/compose/releases/download/v5.4.0/docker-compose-linux-${asset}` +
      " -o /usr/local/lib/docker/cli-plugins/docker-compose",
    "chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose",
  ];
}

describe("envOps docker install", () => {
  it("installs Docker from Amazon's own repo on Amazon Linux 2023", () => {
    // The origin bug. `get.docker.com` reads os-release `ID` verbatim and exits 1 on
    // `amzn`, so running it here left the host with no dockerd — and the Docker-over-SSH
    // bridge turned that into `socket hang up`.
    const install = steps(envOps(HOSTS.amzn2023).dockerInstall());
    expect(install).toEqual(["dnf install -y docker", ...composePluginSteps("x86_64")]);
    expect(opScript(install)).not.toContain("get.docker.com");
  });

  it("uses amazon-linux-extras on Amazon Linux 2", () => {
    // Told apart from AL2023 by package manager (yum vs dnf), never by parsing
    // VERSION_ID: plain `yum install docker` finds no matching package on AL2.
    const install = steps(envOps(HOSTS.amzn2).dockerInstall());
    expect(install[0]).toContain("amazon-linux-extras install -y docker");
    expect(install.slice(1)).toEqual(composePluginSteps("x86_64"));
  });

  it("does not let amazon-linux-extras' exit code abort the plugin steps", () => {
    // Observed on a real amazonlinux:2: one run in four printed "Installation failed" and
    // exited 13 AFTER yum printed "Complete!", with dockerd on disk. Because opScript
    // joins with `&&`, that aborted mkdir/curl/chmod and left an engine with no
    // `docker compose` — provisioning green, first deploy dead. The step must survive a
    // non-zero exit when the binary landed, and only then.
    const first = steps(envOps(HOSTS.amzn2).dockerInstall())[0] as string;
    expect(first).toMatch(/\|\|\s*command -v docker\b/);
    // Braced, so prepending a step can't turn `a && b || c` into a fallthrough: `&&` and
    // `||` bind equally and left-to-right, so an unbraced form would run the `||` arm
    // when an EARLIER step failed.
    expect(first.startsWith("{ ") && first.endsWith("; }")).toBe(true);
    // The tolerance is scoped to the one installer known to lie about its exit code.
    for (const name of HOST_NAMES) {
      if (name === "amzn2") continue;
      const other = envOps(HOSTS[name]).dockerInstall();
      if (!other.supported) continue;
      expect(opScript(other.value as readonly string[]), name).not.toContain("|| command -v docker");
    }
  });

  it("downloads the plugin for the arch the host actually is", () => {
    const arm = host({ osRelease: OS_RELEASE.amzn2023, pm: "dnf", arch: "aarch64" });
    expect(steps(envOps(arm).dockerInstall())).toEqual([
      "dnf install -y docker",
      ...composePluginSteps("aarch64"),
    ]);
  });

  it.each(["ubuntu2404", "debian12", "rocky9", "fedora40", "rhel9", "centos7"] as const)(
    "uses get.docker.com on %s, whose ID the script accepts",
    (hostName) => {
      expect(steps(envOps(HOSTS[hostName]).dockerInstall())).toEqual([
        "curl -fsSL https://get.docker.com | sh",
      ]);
    },
  );

  it.each(["alma9", "oracle9"] as const)("adds Docker's rpm repo on %s", (hostName) => {
    const install = steps(envOps(HOSTS[hostName]).dockerInstall());
    expect(install[0]).toContain("download.docker.com/linux/centos/docker-ce.repo");
    expect(install.at(-1)).toBe(
      "dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    );
    // `dnf config-manager --add-repo` would need dnf-plugins-core first and changed
    // syntax in dnf5; writing the .repo file is what --add-repo does anyway.
    expect(opScript(install)).not.toContain("config-manager");
  });

  it.each(["alma9", "oracle9"] as const)("pins the repo to a major version on %s", (hostName) => {
    // Both report a DOTTED VERSION_ID (9.4), and the centos tree has no 9.4 — it hard-404s
    // where the rhel tree would 301 to the major. dnf substitutes the major on its own
    // here, so this is the image that pinned a point release in /etc/dnf/vars/releasever,
    // which nothing on the host advertises. The major, not VERSION_ID: substituting what
    // was detected verbatim would REQUEST the 404 rather than avoid it.
    const install = steps(envOps(HOSTS[hostName]).dockerInstall());
    expect(HOSTS[hostName].versionId).toBe("9.4");
    expect(install[1]).toBe("sed -i 's|\\$releasever|9|g' /etc/yum.repos.d/docker-ce.repo");
    // Single-quoted, or the shell expands it away before sed ever sees the pattern.
    expect(install[1]).not.toContain('"$releasever"');
  });

  it("leaves $releasever alone on a host that reports no version", () => {
    // Degrade to what shipped before, never to a refusal: `$releasever` is correct on every
    // distro that reports a VERSION_ID, so a host missing one is no worse off than it was.
    const install = steps(
      envOps(host({ osRelease: `ID="almalinux"\nID_LIKE="rhel"`, pm: "dnf" })).dockerInstall(),
    );
    expect(install).toHaveLength(2);
    expect(opScript(install)).not.toContain("sed -i");
  });

  it("installs the distro's docker.io on a Debian derivative", () => {
    // Mint's ID is `linuxmint` and its codename is `virginia`, so Docker's apt repo has no
    // matching suite. `get.docker.com` would take it — `check_forked` rewrites the ID
    // before its switch — but only by deriving a codename at runtime that we cannot check
    // first, so this arm deliberately trades docker-ce for a package that needs no suite.
    expect(HOSTS.mint213.distroFamily).toBe("debian");
    expect(steps(envOps(HOSTS.mint213).dockerInstall())).toEqual([
      "apt-get update -qq",
      "apt-get install -y -qq docker.io",
      ...composePluginSteps("x86_64"),
    ]);
  });

  /**
   * The engine is half the requirement: every deploy path in this product shells out to
   * `docker compose`, so a host that finishes provisioning with dockerd and no plugin fails
   * its FIRST deploy with "docker: 'compose' is not a docker command" — after provisioning
   * reported success. Asserted over every host rather than per arm, because the failure is
   * an arm nobody thought about, and that is exactly the arm a per-arm test doesn't have.
   */
  it("never installs an engine without Compose v2, on any host", () => {
    for (const hostName of HOST_NAMES) {
      const install = envOps(HOSTS[hostName]).dockerInstall();
      if (!install.supported) continue;
      const script = opScript(install.value as readonly string[]);
      const compose =
        // A plugin package from a repo that has one…
        /\bdocker-compose-plugin\b|\bdocker-cli-compose\b/.test(script) ||
        // …the binary, where none does…
        script.includes("cli-plugins/docker-compose") ||
        // …or the vendor script, which appends `docker-compose-plugin` to its own package
        // list on both its apt and its rpm path (verified in the script's source).
        script.includes("get.docker.com");
      expect(compose, `${hostName} installs Docker with no \`docker compose\`: ${script}`).toBe(
        true,
      );
    }
  });

  it("installs docker-cli-compose, not docker-compose, on Alpine", () => {
    // Verified against alpine:3.20's community repo: `docker-compose` does not exist
    // there; the v2 plugin package is `docker-cli-compose`.
    expect(steps(envOps(HOSTS.alpine320).dockerInstall())).toEqual([
      "apk add --no-cache docker docker-cli docker-cli-compose",
    ]);
  });

  it("refuses to install Docker on macOS rather than pretending", () => {
    const install = envOps(HOSTS.macos).dockerInstall();
    expect(install.supported).toBe(false);
    if (!install.supported) expect(install.reason).toContain("Docker Desktop");
  });

  it("starts Docker through the host's own init, including OpenRC's two steps", () => {
    expect(steps(envOps(HOSTS.rocky9).dockerStart())).toEqual(["systemctl enable --now 'docker'"]);
    // The old table returned `undefined` here, so Alpine installed Docker and never
    // started it — OpenRC has no `--now`, and persistence is a separate command.
    expect(steps(envOps(HOSTS.alpine320).dockerStart())).toEqual([
      "rc-update add 'docker' default",
      "rc-service 'docker' start",
    ]);
    expect(envOps(HOSTS.macos).dockerStart().supported).toBe(false);
  });

  it("refuses to start Docker on a host with no init, naming the cause", () => {
    const start = envOps(HOSTS.initless).dockerStart();
    expect(start.supported).toBe(false);
    if (!start.supported) expect(start.reason).toContain("no service manager");
  });
});

describe("envOps packages", () => {
  it("uses each manager's own verbs", () => {
    expect(steps(envOps(HOSTS.ubuntu2404).pkgInstall(["git"]))).toEqual([
      "apt-get update -qq",
      "apt-get install -y -qq git",
    ]);
    expect(steps(envOps(HOSTS.amzn2023).pkgInstall(["git"]))).toEqual(["dnf install -y git"]);
    expect(steps(envOps(HOSTS.centos7).pkgInstall(["git"]))).toEqual(["yum install -y git"]);
    expect(steps(envOps(HOSTS.alpine320).pkgInstall(["git"]))).toEqual([
      "apk add --no-cache git",
    ]);
    expect(steps(envOps(HOSTS.macos).pkgInstall(["git"]))).toEqual(["brew install git"]);
    expect(steps(envOps(HOSTS.alpine320).pkgRemove(["git"]))).toEqual(["apk del git"]);
  });

  it("picks the per-manager package set, and repeats the reason when there isn't one", () => {
    const python = CALLS.pkgInstallVariants;
    expect(steps(python(envOps(HOSTS.ubuntu2404)))).toEqual([
      "apt-get update -qq",
      "apt-get install -y -qq python3 python3-pip python3-venv",
    ]);
    expect(steps(python(envOps(HOSTS.amzn2023)))).toEqual([
      "dnf install -y python3 python3-pip",
    ]);
    // A gap in a toolchain table is a sentence someone wrote, and it survives to here
    // instead of becoming an install that quietly does nothing.
    const onAlpine = python(envOps(HOSTS.alpine320));
    expect(onAlpine.supported).toBe(false);
    if (!onAlpine.supported) expect(onAlpine.reason).toContain("no apk package set for Python");
  });

  it("refuses on a supported host that has no package manager", () => {
    // macOS without Homebrew is `supported: true` — there is no distro to refuse — so
    // the `none` row of every package table is reachable and has to carry a reason.
    expect(HOSTS.macosNoBrew.supported).toBe(true);
    const install = envOps(HOSTS.macosNoBrew).pkgInstall(["git"]);
    expect(install.supported).toBe(false);
    if (!install.supported) expect(install.reason).toContain("apt-get, dnf, yum, apk and brew");
  });

  it("keeps the version-probe command each parser was written against", () => {
    expect(steps(envOps(HOSTS.ubuntu2404).pkgAvailableVersion("git"))).toEqual([
      "apt-cache policy git 2>/dev/null",
    ]);
    expect(steps(envOps(HOSTS.amzn2).pkgAvailableVersion("git"))).toEqual([
      "yum -q --cacheonly list available git 2>/dev/null | tail -n1",
    ]);
    expect(steps(envOps(HOSTS.alpine320).pkgAvailableVersion("git"))).toEqual([
      "apk policy git 2>/dev/null",
    ]);
  });

  it("rejects a package name that isn't one", () => {
    for (const name of ["git; rm -rf /", "$(id)", "git rsync", ""]) {
      const install = envOps(HOSTS.ubuntu2404).pkgInstall([name]);
      expect(install.supported).toBe(false);
    }
    expect(envOps(HOSTS.ubuntu2404).pkgInstall([]).supported).toBe(false);
  });
});

describe("envOps services", () => {
  it("speaks systemd and OpenRC, and quotes the unit name", () => {
    const systemd = envOps(HOSTS.rhel9);
    expect(steps(systemd.serviceEnableStart("openship-api"))).toEqual([
      "systemctl enable --now 'openship-api'",
    ]);
    expect(steps(systemd.serviceIsActive("docker"))).toEqual(["systemctl is-active --quiet 'docker'"]);

    // Two steps on OpenRC, not one: there is no `--now`, which is how Alpine used to get a
    // start command of `undefined` out of a table that assumed systemd.
    const openrc = envOps(HOSTS.alpine320);
    expect(steps(openrc.serviceEnableStart("docker"))).toEqual([
      "rc-update add 'docker' default",
      "rc-service 'docker' start",
    ]);
    expect(steps(openrc.serviceIsActive("docker"))).toEqual([
      "rc-service 'docker' status >/dev/null 2>&1",
    ]);
  });

  it("quotes a unit name that came from data", () => {
    // Unit names arrive from project slugs and from `systemctl list-units` scans, so the
    // guarantee has to hold for a string nobody vetted — quoting, not validation.
    const step = steps(envOps(HOSTS.rhel9).serviceEnableStart("evil; rm -rf /"))[0];
    expect(step).toBe("systemctl enable --now 'evil; rm -rf /'");
  });

  it("refuses every verb on launchd, saying why", () => {
    const enable = envOps(HOSTS.macos).serviceEnableStart("docker");
    expect(enable.supported).toBe(false);
    if (!enable.supported) expect(enable.reason).toContain("launchd");
  });

  it("names ssh on Debian and sshd everywhere else", () => {
    // Hardcoded to `ssh` in the one place it was rendered, which is a command that does
    // nothing on exactly the RHEL hosts most likely to need it.
    expect(envOps(HOSTS.ubuntu2404).sshdEnableHint()).toBe("sudo systemctl enable --now ssh");
    expect(envOps(HOSTS.amzn2023).sshdEnableHint()).toBe("sudo systemctl enable --now sshd");
    expect(envOps(HOSTS.alpine320).sshdEnableHint()).toContain("rc-update add sshd default");
    expect(envOps(HOSTS.macos).sshdEnableHint()).toContain("systemsetup");
  });
});

describe("envOps firewall", () => {
  it("renders each manager's syntax", () => {
    expect(
      steps(envOps(HOSTS.ubuntu2404).firewallAllow({ cidrs: ["172.16.0.0/12"], port: 2222, proto: "tcp" })),
    ).toEqual(["ufw allow from 172.16.0.0/12 to any port 2222 proto tcp"]);

    expect(
      steps(envOps(HOSTS.rocky9).firewallAllow({ cidrs: ["172.16.0.0/12"], port: 2222, proto: "tcp" })),
    ).toEqual([
      'firewall-cmd --permanent --add-rich-rule=\'rule family="ipv4" source address="172.16.0.0/12" port port="2222" protocol="tcp" accept\'',
      "firewall-cmd --reload",
    ]);

    expect(
      steps(envOps(HOSTS.nftables).firewallAllow({ cidrs: [], port: 2222, proto: "tcp" })),
    ).toEqual(["nft add rule inet filter input tcp dport 2222 accept"]);

    expect(
      steps(envOps(HOSTS.rawIptables).firewallAllow({ cidrs: ["10.0.0.0/8"], port: 443, proto: "tcp" })),
    ).toEqual(["iptables -I INPUT -p tcp -s 10.0.0.0/8 --dport 443 -j ACCEPT"]);
  });

  it("answers whether a rule survives a reboot", () => {
    // The CLI refused to apply a rule the API applied, because each had its own idea of
    // which managers persist. One answer now.
    expect(envOps(HOSTS.ubuntu2404).firewallPersists()).toBe(true);
    expect(envOps(HOSTS.rocky9).firewallPersists()).toBe(true);
    expect(envOps(HOSTS.nftables).firewallPersists()).toBe(false);
    expect(envOps(HOSTS.rawIptables).firewallPersists()).toBe(false);
    expect(envOps(HOSTS.debian12).firewallPersists()).toBe(false);
  });

  it("refuses to guess a rule when no manager was identified", () => {
    const unknown = envOps(HOSTS.macos).firewallAllow({ cidrs: [], port: 22, proto: "tcp" });
    expect(unknown.supported).toBe(false);
    if (!unknown.supported) expect(unknown.reason).toContain("could not determine");

    const none = envOps(HOSTS.debian12).firewallAllow({ cidrs: [], port: 22, proto: "tcp" });
    expect(none.supported).toBe(false);
    if (!none.supported) expect(none.reason).toContain("No firewall is active");
  });

  it("rejects a CIDR or port that isn't one", () => {
    const ops = envOps(HOSTS.ubuntu2404);
    expect(ops.firewallAllow({ cidrs: ["$(id)"], port: 22, proto: "tcp" }).supported).toBe(false);
    expect(ops.firewallAllow({ cidrs: [], port: 0, proto: "tcp" }).supported).toBe(false);
    expect(ops.firewallAllow({ cidrs: [], port: 99999, proto: "tcp" }).supported).toBe(false);
  });
});

describe("envOps paths and arch", () => {
  it("derives the login user's own paths from their home, POSIX-style", () => {
    expect(envOps(HOSTS.ubuntu2404).stateDir()).toBe("/root/.openship");
    expect(envOps(HOSTS.macos).home()).toBe("/Users/dev");
    expect(envOps(HOSTS.macos).stateDir()).toBe("/Users/dev/.openship");
    expect(envOps(HOSTS.macos).scratchDir()).toBe("/Users/dev/.openship");
  });

  // `scratchDir` follows the login user; Openship's state does NOT. The journal's wrapper
  // goes up over SFTP, which has no shell and so cannot be elevated at all — a
  // root-anchored base is simply unwritable there on a non-root login. Everything else
  // runs elevated against root-owned files, so deriving `stateDir` from `home()` would
  // strand the existing /root/.openship the moment someone reconnected as a sudo user.
  // On a root login the two coincide, which is why this only ever mattered off-root.
  it("keeps state under root on Linux even when the login user isn't root", () => {
    const sudoer = host({ uid: "1000", user: "ec2-user", home: "/home/ec2-user", sudo: "y" });
    expect(envOps(sudoer).home()).toBe("/home/ec2-user");
    expect(envOps(sudoer).scratchDir()).toBe("/home/ec2-user/.openship");
    expect(envOps(sudoer).stateDir()).toBe("/root/.openship");
    expect(envOps(HOSTS.ubuntu2404).scratchDir()).toBe(envOps(HOSTS.ubuntu2404).stateDir());
  });

  it("gives the release arch, and refuses rather than defaulting to amd64", () => {
    expect(envOps(HOSTS.amzn2023).releaseArch()).toEqual({ supported: true, value: "amd64" });
    expect(envOps(host({ arch: "aarch64" })).releaseArch()).toEqual({
      supported: true,
      value: "arm64",
    });

    // An x86_64 tarball installs cleanly on a riscv64 box and then won't execute, so
    // there is no fallback anywhere — the whole host is refused.
    const arch = envOps(HOSTS.unknownArch).releaseArch();
    expect(arch.supported).toBe(false);
    if (!arch.supported) expect(arch.reason).toContain("architecture");
  });

  it("describes the host in one line, with the facts that select behaviour", () => {
    const described = envOps(HOSTS.amzn2023).describe();
    expect(described).toContain("Amazon Linux 2023");
    expect(described).toContain("linux/amd64");
    expect(described).toContain("pm=dnf");
    expect(described).toContain("init=systemd");
  });
});

describe("envOps on the origin bug", () => {
  it("refuses everything on a host whose sshd answered instead, quoting what it said", () => {
    const profile = HOSTS.forcedCommand;
    expect(profile.forcedCommand).toContain("ec2-user");

    for (const answer of allAnswers(profile)) {
      expect(answer.supported).toBe(false);
      // Quoting the box's own words, not just the generic AWS sentence — a differently
      // worded forced command has to reach the operator too. Before this, the distro gate
      // skipped provisioning, `get.docker.com` was never reached, and the first thing
      // anyone saw was `socket hang up`.
      if (!answer.supported) {
        expect(answer.reason).toContain("Please login as the user");
        expect(answer.reason).toContain("ForceCommand");
      }
    }
  });
});
