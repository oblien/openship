import { describe, expect, it } from "vitest";
import type { EnvironmentProfile } from "@repo/core";

import { parseEnvironmentProbe } from "../system/environment";
import { answeredProbe, OS_RELEASE, type ProbeSpec } from "../system/environment.fixtures";
import { toolchainCatalog } from "./catalog";
import type { ToolStep } from "./types";

/** A host built by the real parser from what the real probe would print. */
function host(spec: ProbeSpec): EnvironmentProfile {
  return parseEnvironmentProbe(answeredProbe(spec));
}

const HOSTS = {
  ubuntu2404: host({ osRelease: OS_RELEASE.ubuntu2404 }),
  debian12: host({ osRelease: OS_RELEASE.debian12 }),
  amzn2023: host({ osRelease: OS_RELEASE.amzn2023, pm: "dnf" }),
  amzn2: host({ osRelease: OS_RELEASE.amzn2, pm: "yum" }),
  rocky9: host({ osRelease: OS_RELEASE.rocky9, pm: "dnf" }),
  fedora40: host({ osRelease: OS_RELEASE.fedora40, pm: "dnf" }),
  centos7: host({ osRelease: OS_RELEASE.centos7, pm: "yum" }),
  alpine320: host({ osRelease: OS_RELEASE.alpine320, pm: "apk", sm: "openrc", libc: "musl" }),
  opensuse156: host({ osRelease: OS_RELEASE.opensuse156, pm: "none" }),
  arch: host({ osRelease: OS_RELEASE.arch, pm: "none" }),
  /** Unplaceable ID *and* nothing to install with. An unplaceable ID alone is driven —
   *  the package manager is the gate, not the family name. */
  mysteryNoPm: host({ osRelease: OS_RELEASE.mystery, pm: "none" }),
  unknownArch: host({ arch: "riscv64" }),
  macos: host({
    os: "Darwin",
    osRelease: null,
    pm: "brew",
    sm: "launchd",
    uid: "501",
    user: "dev",
    home: "/Users/dev",
  }),
} satisfies Record<string, EnvironmentProfile>;

type HostName = keyof typeof HOSTS;
const HOST_NAMES = Object.keys(HOSTS) as HostName[];

const TOOLS = Object.keys(toolchainCatalog.installs);

/** The steps a host would actually run, or `[]` if the plan refuses. */
function stepsFor(tool: string, profile: EnvironmentProfile): readonly ToolStep[] {
  const plan = toolchainCatalog.installs[tool]!(profile);
  return plan.supported ? plan.value.steps : [];
}

/** Every step as one script — what the old single `installCommand` used to be. */
function script(tool: string, profile: EnvironmentProfile): string {
  return stepsFor(tool, profile)
    .map((step) => step.command)
    .join(" && ");
}

/** What each host may spell. Anything else in a rendered command is a leak. */
const FOREIGN_MANAGERS: Readonly<Record<string, readonly string[]>> = {
  apt: ["dnf ", "yum ", "apk ", "brew ", "zypper", "pacman"],
  dnf: ["apt-get", "yum ", "apk ", "brew ", "zypper", "pacman"],
  yum: ["apt-get", "dnf ", "apk ", "brew ", "zypper", "pacman"],
  apk: ["apt-get", "dnf ", "yum ", "brew ", "zypper", "pacman"],
  brew: ["apt-get", "dnf ", "yum ", "apk ", "zypper", "pacman"],
  none: ["apt-get", "dnf ", "yum ", "apk ", "brew ", "zypper", "pacman"],
};

describe("toolchain catalog / halves agree", () => {
  // The compile-time version of this is `Record<InstallableTool, ToolRecipe>`; this is
  // the runtime mirror, because both halves are exposed through a `Record<string, …>`
  // cast (the installer indexes them with a plain string) and a cast can erase the
  // guarantee. The old catalog's halves were `Record<string, …>` all the way down, which
  // is how a tool could claim to be installable with nothing to install it.
  it("gives every installable tool an installer, and installs nothing else", () => {
    const installable = Object.entries(toolchainCatalog.checks)
      .filter(([, entry]) => entry.installable)
      .map(([name]) => name)
      .sort();
    expect([...TOOLS].sort()).toEqual(installable);
  });

  it("names a parent for every tool that isn't installable on its own", () => {
    for (const [name, entry] of Object.entries(toolchainCatalog.checks)) {
      if (entry.installable) continue;
      expect(entry.providedBy, `${name} is neither installable nor provided`).toBeTruthy();
      expect(toolchainCatalog.checks[entry.providedBy!]).toBeDefined();
    }
  });
});

describe.each(HOST_NAMES)("toolchain catalog / %s", (name) => {
  const profile = HOSTS[name];

  // The property that makes "never a silent skip" mechanically true per distro: a plan is
  // a command or a reason, and there is no third shape. An empty command would install
  // nothing and report success; an empty reason would tell an operator nothing.
  it.each(TOOLS)("answers or refuses %s, with substance either way", (tool) => {
    const plan = toolchainCatalog.installs[tool]!(profile);
    if (plan.supported) {
      expect(plan.value.steps.length).toBeGreaterThan(0);
      for (const step of plan.value.steps) {
        expect(step.command.trim().length).toBeGreaterThan(0);
      }
      expect(plan.value.verifyCommand.trim().length).toBeGreaterThan(0);
    } else {
      expect(plan.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it.each(TOOLS)("never spells another host's package manager in %s", (tool) => {
    for (const foreign of FOREIGN_MANAGERS[profile.packageManager]!) {
      expect(script(tool, profile)).not.toContain(foreign);
    }
  });

  // The A3 guard, and the reason `as` exists at all.
  //
  // `HOME` is the one variable a root step may not lean on: sudo rewrites it to root's,
  // so a step that installs "into $HOME" as root puts its payload in a 0700 /root the
  // build user cannot even traverse. Pinning `HOME=ops.home()` fixes the *path* and makes
  // it worse in a subtler way — root then owns the login user's own `~/.bun` / `~/.cargo`,
  // `verify` passes because it only reads, and the build's first write there fails EACCES.
  //
  // So the rule is about authority, not spelling: a step that mentions a home at all must
  // run as the login user. This assertion, not the type, is what stops A3 recurring.
  it.each(TOOLS)("never runs a home-directory step as root, in %s", (tool) => {
    for (const step of stepsFor(tool, profile)) {
      if (step.as !== "root") continue;
      expect(step.command, `${tool}: a root step leans on a home directory`).not.toMatch(
        /\$HOME|\bHOME=/,
      );
    }
  });

  // A1, generalised: /etc/profile.d is not sourced by the non-login `ssh host 'go build'`
  // a build actually runs through, so a payload outside a default PATH directory is
  // invisible to it. Go was the only recipe of fifteen that unpacked into /usr/local/go
  // and stopped there — the install went green and `go build` exited 127.
  it.each(TOOLS)("links %s into /usr/local/bin when its payload lands off PATH", (tool) => {
    const joined = script(tool, profile);
    if (!OFF_PATH_PREFIX.test(joined)) return;
    expect(joined, `${tool}: installs off PATH and never links into /usr/local/bin`).toContain(
      "/usr/local/bin",
    );
  });
});

/**
 * An install prefix that is NOT on a default PATH: /usr/local/<not bin>, /opt/<x>, or a
 * dotted directory under a home. Deliberately a shape rather than a list of known tools,
 * so a future tarball recipe unpacking into /usr/local/foo is covered without being named.
 */
const OFF_PATH_PREFIX =
  /\/usr\/local\/(?!bin\b)[A-Za-z0-9._-]+|\/opt\/[A-Za-z0-9._-]+|\/[^\s'"]*\/\.[A-Za-z0-9._-]+\/bin/;

// A regex that matches nothing would make the rule above vacuous on every host, which is
// the failure mode of every source-level guard. Pin that it still bites.
it("has an off-PATH rule that actually matches the recipes that install off PATH", () => {
  const matched = TOOLS.filter((tool) => OFF_PATH_PREFIX.test(script(tool, HOSTS.ubuntu2404)));
  expect(matched.sort()).toEqual(["bun", "dotnet", "go", "rustc"]);
});

describe("toolchain catalog / Amazon Linux is not just another dnf host", () => {
  const install = (tool: string, profile: EnvironmentProfile) => {
    const plan = toolchainCatalog.installs[tool]!(profile);
    return plan.supported ? script(tool, profile) : `REFUSED: ${plan.reason}`;
  };

  // AL2023 and Rocky 9 are both dnf, and disagree on all three of these names. A table
  // keyed on the package manager alone installed nothing on whichever it guessed against
  // — which is the bug that started this: `dnf install -y ruby ruby-devel` on AL2023
  // fails with "No match for argument", and a Ruby build then died on a missing `ruby`.
  it("uses Amazon's versioned ruby, and the RHEL family's unversioned one", () => {
    expect(install("ruby", HOSTS.amzn2023)).toContain("ruby3.2 ruby3.2-devel");
    expect(install("ruby", HOSTS.rocky9)).toContain("ruby ruby-devel");
    expect(install("ruby", HOSTS.rocky9)).not.toContain("ruby3.2");
  });

  it("uses Amazon's versioned php, and never php-curl on an RPM host", () => {
    expect(install("php", HOSTS.amzn2023)).toContain("php8.2-cli php8.2-mbstring php8.2-xml");
    expect(install("php", HOSTS.rocky9)).toContain("php-cli php-mbstring php-xml");
    // Curl support is in `php-common` on the RPM side; there is no `php-curl` package to
    // install, and asking for one fails the whole transaction.
    expect(install("php", HOSTS.rocky9)).not.toContain("php-curl");
    expect(install("php", HOSTS.amzn2023)).not.toContain("php-curl");
    expect(install("php", HOSTS.ubuntu2404)).toContain("php-curl");
  });

  it("uses Corretto on Amazon and OpenJDK elsewhere", () => {
    expect(install("java", HOSTS.amzn2023)).toContain("java-21-amazon-corretto-devel");
    expect(install("java", HOSTS.rocky9)).toContain("java-21-openjdk-devel");
    expect(install("java", HOSTS.ubuntu2404)).toContain("openjdk-21-jdk");
  });

  it("installs Docker-era Node from the vendor repo on Amazon Linux, which has none", () => {
    expect(install("node", HOSTS.amzn2023)).toContain("rpm.nodesource.com");
  });
});

describe("toolchain catalog / refuses instead of installing the wrong thing", () => {
  const refusal = (tool: string, profile: EnvironmentProfile) => {
    const plan = toolchainCatalog.installs[tool]!(profile);
    expect(plan.supported, `${tool} unexpectedly answered`).toBe(false);
    return plan.supported ? "" : plan.reason;
  };

  // AL2's newest JDK is java-1.8.0-openjdk-devel. Installing Java 8 for a recipe that
  // promises 21 is worse than refusing: the build then fails deep in javac with a class
  // file version error that names nothing an operator can act on.
  it("won't substitute an older JDK for the one asked for", () => {
    expect(refusal("java", HOSTS.amzn2)).toMatch(/Java 8\/11/);
    expect(refusal("java", HOSTS.centos7)).toMatch(/newer OS release|container/);
  });

  // The old table ran `dnf install -y erlang elixir` on hosts that have neither, and
  // reported the failure as a generic non-zero exit.
  it("says elixir needs EPEL on the RHEL family rather than failing opaquely", () => {
    for (const rpm of [HOSTS.amzn2023, HOSTS.rocky9, HOSTS.centos7]) {
      expect(refusal("elixir", rpm)).toMatch(/EPEL/);
    }
  });

  // …but not on Fedora, which is `dnf` and carries both in its own repos. Keying the
  // refusal on the package manager sent a Fedora operator to enable EPEL for a package
  // Fedora already has — and EPEL has no Fedora branch, so the advice was impossible to
  // follow. The distro, not the manager, is what decides here.
  it("installs elixir on Fedora, which is dnf and has it", () => {
    const plan = toolchainCatalog.installs.elixir!(HOSTS.fedora40);
    expect(plan.supported).toBe(true);
    expect(script("elixir", HOSTS.fedora40)).toContain("erlang elixir");
  });

  // NodeSource's Node 18+ RPMs link against glibc 2.28; AL2 ships 2.26 and CentOS 7
  // ships 2.17. The package installs cleanly and then every `node` invocation dies on a
  // missing symbol, so the failure surfaced at the first build step rather than here.
  // Everything modern in the RHEL family is dnf, which makes `yum` a precise proxy.
  it("won't install a Node the host's glibc cannot load", () => {
    for (const old of [HOSTS.amzn2, HOSTS.centos7]) {
      expect(refusal("node", old)).toMatch(/glibc 2\.28/);
    }
  });

  // Alpine is busybox ash. Piping bun's installer into `bash` fails with "bash: not
  // found", and the fix is not to add bash to the operator's host to satisfy an installer.
  it("won't pipe a bash installer into a host with no bash", () => {
    expect(refusal("bun", HOSTS.alpine320)).toMatch(/bash/);
    expect(refusal("composer", HOSTS.alpine320)).toMatch(/php-phar/);
  });

  it("points at ./gradlew where there is no gradle package", () => {
    expect(refusal("gradle", HOSTS.rocky9)).toContain("./gradlew");
  });

  it("names the architecture when it can't pick a Go build", () => {
    expect(refusal("go", HOSTS.unknownArch)).toMatch(/architecture/i);
  });

  it("refuses every tool on a host it does not support, naming the distro", () => {
    for (const unsupported of [HOSTS.opensuse156, HOSTS.arch, HOSTS.mysteryNoPm]) {
      for (const tool of TOOLS) {
        const plan = toolchainCatalog.installs[tool]!(unsupported);
        expect(plan.supported, `${tool} answered for ${unsupported.distroId}`).toBe(false);
        if (plan.supported) continue;
        expect(plan.reason).toContain(unsupported.distroId!);
      }
    }
  });
});

describe("toolchain catalog / musl", () => {
  const install = (tool: string) => {
    const plan = toolchainCatalog.installs[tool]!(HOSTS.alpine320);
    expect(plan.supported, `${tool} refused on Alpine`).toBe(true);
    return script(tool, HOSTS.alpine320);
  };

  // Every one of these upstream installers resolves a glibc target and produces a binary
  // that cannot exec on musl, so Alpine has to come from apk. Each of these five arms was
  // either a refusal or a glibc download before.
  it("takes the distro's build rather than a glibc download", () => {
    expect(install("go")).toContain("apk add");
    expect(install("go")).not.toContain("go.dev/dl");
    expect(install("rustc")).toContain("apk add");
    expect(install("rustc")).not.toContain("rustup.rs");
    expect(install("dotnet")).toContain("dotnet8-sdk");
    expect(install("dotnet")).not.toContain("dot.net");
    expect(install("node")).toContain("nodejs npm");
    expect(install("elixir")).toContain("elixir erlang");
  });

  // Alpine has no unversioned php package, but php83 does ship the /usr/bin/php symlink,
  // so the verify command can stay version-agnostic.
  it("installs Alpine's versioned php and still verifies with a bare `php`", () => {
    expect(install("php")).toContain("php83");
    const plan = toolchainCatalog.installs.php!(HOSTS.alpine320);
    expect(plan.supported && plan.value.verifyCommand).toBe("php --version");
  });
});

describe("toolchain catalog / bun's installer prerequisites", () => {
  // `command -v unzip >/dev/null || error 'unzip is required to install bun'` is the second
  // line bun.sh/install runs, and Debian slim, AL2023 and a minimal Rocky ship no unzip —
  // so a bun toolchain step died with a message about unzip and nothing about bun.
  it.each(["ubuntu2404", "debian12", "amzn2023", "rocky9", "centos7"] as const)(
    "installs unzip before piping bun's installer on %s",
    (name) => {
      const profile = HOSTS[name];
      const steps = stepsFor("bun", profile);
      const unzip = steps.findIndex((step) => step.command.includes("unzip"));
      const installer = steps.findIndex((step) => step.command.includes("bun.sh/install"));
      expect(unzip, "no step mentions unzip").toBeGreaterThanOrEqual(0);
      expect(installer).toBeGreaterThan(unzip);
      // A package install writes host-wide, so it is the one half of this recipe that IS root.
      expect(steps[unzip]!.as).toBe("root");
    },
  );

  // The package NAME stays here; the verb comes from `envOps`, which the ownership guard
  // over this file enforces. Asserted per-manager so a hardcoded `apt-get` cannot pass.
  it("routes the prerequisite through each host's own manager", () => {
    expect(script("bun", HOSTS.ubuntu2404)).toContain("apt-get install -y -qq unzip");
    expect(script("bun", HOSTS.amzn2023)).toContain("dnf install -y unzip");
    expect(script("bun", HOSTS.centos7)).toContain("yum install -y unzip");
  });

  // macOS has unzip in the base system and Homebrew's formula is keg-only, so installing
  // it there would be a no-op that fails the "another host's manager" rule for nothing.
  it("does not install unzip on macOS", () => {
    expect(script("bun", HOSTS.macos)).not.toContain("unzip");
  });
});
