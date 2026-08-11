/**
 * Toolchain catalog — how to detect each language tool, and how to install it here.
 *
 *   - `checks`   → recipes for detecting a tool and reading its version
 *   - `installs` → per-host install plans, keyed by the same tool names
 *
 * No package-manager verb is spelled in this file. Only package NAMES are, because a
 * name is a fact about the tool while `apt-get install -y -qq` is a fact about the host —
 * that half comes from `envOps`, which is the one place a manager is named.
 *
 * The names below were verified with `dnf`/`yum`/`apk` inside real `amazonlinux:2023`,
 * `amazonlinux:2`, `rockylinux:9` and `alpine:3.20` images rather than recalled, because
 * they are not guessable and the old tables had them wrong: Amazon Linux 2023 has no
 * unversioned `ruby`, no `php-cli` and no `java-21-openjdk-devel` — yet it is `dnf`,
 * exactly like Rocky, which has all three. A table keyed on the package manager alone
 * cannot serve both, and the old one installed nothing on whichever it guessed against.
 */

import { answered, refused, shellQuote, type Answer } from "@repo/core";

import type { EnvironmentProfile } from "../system/environment";
import { envOps, hostRefusal, opScript, type EnvOps, type Op } from "../system/environment-ops";
import type {
  ToolchainCheckEntry,
  ToolchainInstallPlan,
  ToolStep,
  ToolStepUser,
} from "./types";

// ─── Check recipes ───────────────────────────────────────────────────────────

const CHECKS = {
  node: {
    label: "Node.js",
    versionCommand: "node --version",
    parseVersion: (output: string) => output.replace(/^v/, "").trim(),
    missingMessage: "Node.js is not installed",
    installable: true,
  },
  bun: {
    label: "Bun",
    versionCommand: "bun --version",
    parseVersion: (output: string) => output.trim(),
    missingMessage: "Bun is not installed",
    installable: true,
  },
  npm: {
    label: "npm",
    versionCommand: "npm --version",
    parseVersion: (output: string) => output.trim(),
    missingMessage: "npm is not installed",
    installable: false,
    providedBy: "node",
  },
  go: {
    label: "Go",
    versionCommand: "go version",
    parseVersion: (output: string) => output.match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? output.trim(),
    missingMessage: "Go is not installed",
    installable: true,
  },
  rustc: {
    label: "Rust compiler",
    versionCommand: "rustc --version",
    parseVersion: (output: string) => output.match(/rustc (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Rust compiler is not installed",
    installable: true,
  },
  cargo: {
    label: "Cargo",
    versionCommand: "cargo --version",
    parseVersion: (output: string) => output.match(/cargo (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Cargo is not installed",
    installable: false,
    providedBy: "rustc",
  },
  python3: {
    label: "Python 3",
    versionCommand: "python3 --version",
    parseVersion: (output: string) => output.match(/Python (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Python 3 is not installed",
    installable: true,
  },
  pip: {
    label: "pip",
    versionCommand: "pip3 --version || pip --version",
    parseVersion: (output: string) => output.match(/pip (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "pip is not installed",
    installable: true,
    providedBy: "python3",
  },
  ruby: {
    label: "Ruby",
    versionCommand: "ruby --version",
    parseVersion: (output: string) => output.match(/ruby (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Ruby is not installed",
    installable: true,
  },
  bundler: {
    label: "Bundler",
    versionCommand: "bundler --version",
    parseVersion: (output: string) => output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? output.trim(),
    missingMessage: "Bundler is not installed",
    installable: true,
    providedBy: "ruby",
  },
  php: {
    label: "PHP",
    versionCommand: "php --version",
    parseVersion: (output: string) => output.match(/PHP (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "PHP is not installed",
    installable: true,
  },
  composer: {
    label: "Composer",
    versionCommand: "composer --version",
    parseVersion: (output: string) => output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? output.trim(),
    missingMessage: "Composer is not installed",
    installable: true,
    providedBy: "php",
  },
  java: {
    label: "Java",
    versionCommand: "java --version 2>&1 || java -version 2>&1",
    parseVersion: (output: string) => output.match(/(\d+\.\d+)/)?.[1] ?? output.trim(),
    missingMessage: "Java is not installed",
    installable: true,
  },
  javac: {
    label: "Java compiler",
    versionCommand: "javac --version 2>&1 || javac -version 2>&1",
    parseVersion: (output: string) => output.match(/javac (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Java compiler (javac) is not installed",
    installable: false,
    providedBy: "java",
  },
  maven: {
    label: "Maven",
    versionCommand: "mvn -version 2>&1",
    parseVersion: (output: string) => output.match(/Apache Maven (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Maven is not installed",
    installable: true,
  },
  gradle: {
    label: "Gradle",
    versionCommand: "gradle --version 2>&1",
    parseVersion: (output: string) => output.match(/Gradle (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Gradle is not installed",
    installable: true,
  },
  dotnet: {
    label: ".NET SDK",
    versionCommand: "dotnet --version",
    parseVersion: (output: string) => output.trim(),
    missingMessage: ".NET SDK is not installed",
    installable: true,
  },
  elixir: {
    label: "Elixir",
    versionCommand: "elixir --version 2>&1",
    parseVersion: (output: string) => output.match(/Elixir (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Elixir is not installed",
    installable: true,
  },
  mix: {
    label: "Mix",
    versionCommand: "mix --version 2>&1",
    parseVersion: (output: string) => output.match(/Mix (\S+)/)?.[1] ?? output.trim(),
    missingMessage: "Mix is not installed",
    installable: false,
    providedBy: "elixir",
  },
} satisfies Record<string, ToolchainCheckEntry>;

/**
 * Every tool that claims to be auto-installable.
 *
 * Derived from `CHECKS` rather than listed, which makes {@link RECIPES} total in both
 * directions: a tool marked `installable` with no recipe is TS2741, and a recipe under a
 * key that isn't in `CHECKS` — a typo, which used to read as "not installable" — is
 * TS2353. The old catalog's two halves were both `Record<string, …>`, so they could and
 * did drift apart silently.
 */
type InstallableTool = {
  [K in keyof typeof CHECKS]: (typeof CHECKS)[K]["installable"] extends true ? K : never;
}[keyof typeof CHECKS];

// ─── Install recipes ─────────────────────────────────────────────────────────

/** Labelled steps for a host, or the reason it has none. */
type ToolSteps = Answer<readonly ToolStep[]>;

/** How to install one tool, given a host that has already been resolved. */
interface ToolRecipe {
  /** Run once the install succeeds, to prove it and read a version. */
  readonly verify: string;
  /** The steps for this host, or the reason it has none. */
  steps(ops: EnvOps): ToolSteps;
}

/**
 * Label literal commands and ops with one authority; the first refusal wins.
 *
 * Ops are labelled by the caller rather than assumed root because the caller is the only
 * one who knows *where the payload lands* — which is the thing authority follows. A bare
 * string cannot reach a recipe unlabelled: `ToolStep` is not `string`, so forgetting is
 * TS2322 rather than a default that is right 13 times out of 15.
 *
 * The alternative — reading steps off an op and spreading them — needs a non-null
 * assertion or an `?? []`, and `?? []` is precisely the silent skip this layer exists to
 * make unrepresentable.
 */
function label(as: ToolStepUser, parts: readonly (string | Op)[]): ToolSteps {
  const steps: ToolStep[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      steps.push({ command: part, as });
      continue;
    }
    if (!part.supported) return part;
    for (const command of part.value) steps.push({ command, as });
  }
  return answered(steps);
}

/** Writes host-wide: a package manager, /usr, /usr/local/bin. */
function asRoot(...parts: readonly (string | Op)[]): ToolSteps {
  return label("root", parts);
}

/** Lands in the login user's own home, so it must NOT be elevated. */
function asLogin(...parts: readonly (string | Op)[]): ToolSteps {
  return label("login", parts);
}

/** Sequence groups of differing authority; the first refusal wins. */
function chain(...parts: readonly ToolSteps[]): ToolSteps {
  const steps: ToolStep[] = [];
  for (const part of parts) {
    if (!part.supported) return part;
    steps.push(...part.value);
  }
  return answered(steps);
}

/**
 * Amazon Linux, which spells several RHEL-family packages its own way.
 *
 * AL2 and AL2023 are told apart by package manager (yum vs dnf) wherever they differ,
 * the same way `envOps`'s Docker path does it — never by parsing `VERSION_ID`.
 */
function isAmazon(profile: EnvironmentProfile): boolean {
  return profile.distroId?.trim().toLowerCase() === "amzn";
}

/** The Node LTS major to install. Bump on a new LTS. */
const NODE_LTS_MAJOR = 22;

/** Pinned so a toolchain install is reproducible across hosts. */
const GO_VERSION = "1.22.5";
const BUN_VERSION = "1.2.0";
const DOTNET_CHANNEL = "8.0";

/**
 * Composer's own installer — the one path that works on every distro.
 *
 * PHP declares `composer` in its `requiredTools`, so the installer always reaches this
 * recipe on its own. The PHP recipe used to append this same `curl` to its apt and dnf
 * package lists, which is why the string appeared three times.
 */
const COMPOSER_INSTALL =
  "curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer";

const NO_EPEL =
  "and Openship does not enable third-party repositories (EPEL) on a host it did not " +
  "provision. Install it yourself, or build in a container.";

const NO_GRADLE_RPM =
  `The RHEL family ships no gradle package ${NO_EPEL} Most projects include a ./gradlew ` +
  `wrapper, which the build prefers anyway and which needs only a JDK.`;

const NO_ELIXIR_RPM = `The RHEL family ships no elixir or erlang package ${NO_EPEL}`;

/**
 * unzip, which bun.sh/install checks for before it downloads anything.
 *
 * `command -v unzip >/dev/null || error 'unzip is required to install bun'` is the second
 * thing that script runs, and Debian slim, AL2023 and a minimal Rocky all ship without it
 * — so the toolchain step failed with a sentence about unzip and nothing about bun.
 *
 * Probed rather than installed outright because an index refresh is the slow half of this
 * whole recipe on apt and unzip is already there on a full install — and because a host
 * with no package manager has no install to render, where the probe leaves the pure-curl
 * recipe intact instead of turning bun into the one curl-installed toolchain Openship
 * refuses on a box it would have worked on.
 */
function ensureUnzip(ops: EnvOps): ToolSteps {
  // macOS ships unzip in the base system, and Homebrew's formula is keg-only there.
  if (ops.profile.os === "darwin") return answered([]);
  const install = ops.pkgInstall(["unzip"]);
  if (!install.supported) return answered([]);
  return asRoot(`command -v unzip >/dev/null 2>&1 || { ${opScript(install.value)}; }`);
}

const RECIPES: Record<InstallableTool, ToolRecipe> = {
  node: {
    verify: "node --version",
    // Total over `SystemPackageManager` with no `default`, so a new manager is a
    // "function lacks ending return statement" error rather than a silent fallthrough.
    steps: (ops): ToolSteps => {
      switch (ops.profile.packageManager) {
        case "apt":
          // NodeSource's `setup_lts.x` pins the apt repo to $(lsb_release -sc), so it
          // breaks on a codename it hasn't published for — the same way the OpenResty
          // repo did — and leaves behind a poisoned nodesource.list that then fails every
          // later apt run on the box. Their node_XX.x repos are served under the
          // distro-agnostic `nodistro` suite, so add that directly: no codename, no
          // `curl | bash` of a remote script, and heal a stale list first.
          return asRoot(
            "rm -f /etc/apt/sources.list.d/nodesource.list",
            ops.pkgInstall(["curl", "gnupg", "ca-certificates"]),
            "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg",
            `echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_LTS_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list`,
            ops.pkgInstall(["nodejs"]),
          );
        case "dnf":
          // AL2023's own repos carry no `nodejs` at all, so the vendor script is the only
          // route there, and it is the supported route on every other modern RPM host.
          return asRoot(
            `curl -fsSL https://rpm.nodesource.com/setup_${NODE_LTS_MAJOR}.x | bash -`,
            ops.pkgInstall(["nodejs"]),
          );
        case "yum":
          // Same refusal-by-release as java below, for the same reason and on the same
          // proxy: everything still on yum in the RHEL family (AL2, CentOS/RHEL 7) ships
          // a glibc older than 2.28, and NodeSource builds Node 18+ against 2.28. The
          // script installs happily and the resulting `node` cannot dynamically link, so
          // every later step dies in the ELF loader — a message that names the loader and
          // nothing an operator can act on. Refusing here says the true thing instead.
          return refused(
            `Node ${NODE_LTS_MAJOR} needs glibc 2.28 or newer and this host's release ` +
              `(${ops.profile.prettyName ?? ops.profile.distroId ?? "unknown"}) ships an ` +
              `older one, so the vendor package would install and then fail to load. Use a ` +
              `newer OS release, or build in a container.`,
          );
        case "apk":
          // Alpine's `nodejs` trails NodeSource by a minor but is real, and npm is a
          // separate package there. This arm used to be a flat refusal, which is why an
          // Alpine host could not install a Node toolchain at all.
          return asRoot(ops.pkgInstall(["nodejs", "npm"]));
        case "brew":
          return asRoot(ops.pkgInstall(["node"]));
        case "none":
          // Renders `pkgInstall`'s one no-package-manager refusal, naming the packages.
          return asRoot(ops.pkgInstall(["nodejs"]));
      }
    },
  },

  bun: {
    verify: "bun --version",
    steps: (ops): ToolSteps => {
      // bun.sh/install is a bash script and Alpine ships busybox ash, so the pipe ends in
      // `bash: not found` (exit 127) reported as a failed install. Installing bash to work
      // around it would be Openship adding a shell to someone's host to satisfy a vendor
      // script, and there is no apk `bun` to prefer instead.
      if (ops.profile.libc === "musl") {
        return refused(
          "Bun's official installer is a bash script and this host is musl-based (Alpine), " +
            "which ships busybox ash and no bash. Openship will not add a shell to a host " +
            "to satisfy an installer. Use Node for this project, or build in a container.",
        );
      }
      return chain(
        ensureUnzip(ops),
        // The download lands in the login user's own home, so it must NOT be elevated:
        // under sudo, HOME becomes root's and root would own ~/.bun, leaving `bun install`
        // unable to write its own cache while `verify` still passes because it only reads.
        //
        // HOME is pinned to `home()` rather than left to `$HOME` so the install prefix and
        // the symlink target below are derived from the same value and cannot diverge. The
        // assignment sits on the `bash`, not the `curl` — it prefixes exactly one command,
        // and it is the interpreter that chooses the prefix.
        asLogin(
          `curl -fsSL https://bun.sh/install | HOME=${shellQuote(ops.home())} bash -s 'bun-v${BUN_VERSION}'`,
        ),
        // /usr/local/bin is root-owned, and this is what puts bun on PATH for a build.
        asRoot(`ln -sf ${shellQuote(`${ops.home()}/.bun/bin/bun`)} /usr/local/bin/bun`),
      );
    },
  },

  go: {
    verify: "go version",
    steps: (ops): ToolSteps => {
      // The upstream tarball's toolchain is static, but anything it then builds with cgo
      // links against glibc — so on musl the distro's own build is the correct one.
      if (ops.profile.libc === "musl") return asRoot(ops.pkgInstall(["go"]));
      if (ops.profile.os === "darwin") return asRoot(ops.pkgInstall(["go"]));

      const arch = ops.releaseArch();
      if (!arch.supported) return arch;
      return asRoot(
        `curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-${arch.value}.tar.gz -o /tmp/go.tar.gz`,
        "rm -rf /usr/local/go",
        "tar -C /usr/local -xzf /tmp/go.tar.gz",
        "rm -f /tmp/go.tar.gz",
        // The profile.d line is for an operator's interactive login only. A build runs
        // through a NON-login `ssh host 'go build'`, which sources nothing, so this was
        // the only recipe of the fifteen whose payload never reached a build's PATH: the
        // install went green and `go build` then exited 127. The symlink is what actually
        // puts it there — Go resolves GOROOT from /proc/self/exe, so a link is transparent.
        "ln -sf /usr/local/go/bin/go /usr/local/bin/go",
        "ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt",
        "echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh",
      );
    },
  },

  rustc: {
    verify: ". $HOME/.cargo/env 2>/dev/null; rustc --version",
    steps: (ops): ToolSteps =>
      // rustup's default host triple is gnu, so on musl it fetches a toolchain that
      // cannot run. Alpine's rust package is built for the box it's on.
      ops.profile.libc === "musl"
        ? asRoot(ops.pkgInstall(["rust", "cargo"]))
        : chain(
            // Unelevated for the same reason as bun, and doubly so here: rustup owns BOTH
            // ~/.cargo and ~/.rustup, and `cargo build` writes into the registry cache
            // under ~/.cargo on every build. Pinned HOME also makes `verify`
            // (`. $HOME/.cargo/env`, run unelevated) look where the toolchain landed.
            asLogin(
              `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | HOME=${shellQuote(ops.home())} sh -s -- -y --no-modify-path`,
            ),
            asRoot(
              `ln -sf ${shellQuote(`${ops.home()}/.cargo/bin/cargo`)} ${shellQuote(`${ops.home()}/.cargo/bin/rustc`)} /usr/local/bin/`,
            ),
          ),
  },

  python3: {
    verify: "python3 --version",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["python3", "python3-pip", "python3-venv"]),
          // No `python3-venv` on the RPM side — venv lives in `python3-libs` there.
          dnf: answered(["python3", "python3-pip"]),
          yum: answered(["python3", "python3-pip"]),
          apk: answered(["python3", "py3-pip"]),
          brew: answered(["python3"]),
        }),
      ),
  },

  pip: {
    verify: "pip3 --version || pip --version",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["python3-pip"]),
          dnf: answered(["python3-pip"]),
          yum: answered(["python3-pip"]),
          apk: answered(["py3-pip"]),
          // Homebrew has no `pip` formula; pip arrives with its python.
          brew: refused(
            "Homebrew installs pip as part of Python — install the python3 tool instead.",
          ),
        }),
      ),
  },

  ruby: {
    verify: "ruby --version",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["ruby-full", "build-essential"]),
          // AL2023 has no unversioned `ruby`; Rocky/Alma/RHEL/Fedora do. Both are dnf,
          // which is exactly the split a package-manager-keyed table cannot express.
          dnf: answered(
            isAmazon(ops.profile) ? ["ruby3.2", "ruby3.2-devel"] : ["ruby", "ruby-devel"],
          ),
          yum: answered(["ruby", "ruby-devel"]),
          // `build-base` because musl has no prebuilt native gems to fall back on.
          apk: answered(["ruby", "ruby-dev", "build-base"]),
          brew: answered(["ruby"]),
        }),
      ),
  },

  bundler: {
    verify: "bundler --version",
    // Ships with every supported Ruby as a default gem; `gem install` only upgrades it.
    // No distro package is worth preferring here.
    steps: () => asRoot("gem install bundler"),
  },

  php: {
    verify: "php --version",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["php-cli", "php-mbstring", "php-xml", "php-curl", "unzip"]),
          // There is no `php-curl` anywhere on the RPM side — curl support ships in
          // `php-common`, which the cli package pulls in. AL2023 versions every name.
          dnf: answered(
            isAmazon(ops.profile)
              ? ["php8.2-cli", "php8.2-mbstring", "php8.2-xml"]
              : ["php-cli", "php-mbstring", "php-xml"],
          ),
          yum: answered(["php-cli", "php-mbstring", "php-xml"]),
          // Alpine versions the package and symlinks /usr/bin/php → php83, so `verify`
          // holds without the recipe naming a version.
          apk: answered(["php83"]),
          brew: answered(["php"]),
        }),
      ),
  },

  composer: {
    verify: "composer --version",
    steps: (ops): ToolSteps => {
      if (ops.profile.packageManager === "brew") return asRoot(ops.pkgInstall(["composer"]));
      // Alpine splits PHP into one package per extension, and composer.phar needs `phar`
      // and `openssl` — neither of which comes with the `php83` the PHP recipe installs.
      // The upstream installer's own check then fails on a missing extension. Openship
      // will not guess at per-extension package names it has not verified on a real host,
      // so this is a refusal that names what is missing rather than an opaque exit.
      if (ops.profile.libc === "musl") {
        return refused(
          "Composer needs PHP's phar and openssl extensions, and on musl hosts (Alpine) " +
            "those ship as separate packages that Openship does not install. Add " +
            "php-phar and php-openssl for your PHP version yourself, or build in a " +
            "container.",
        );
      }
      return asRoot(COMPOSER_INSTALL);
    },
  },

  java: {
    verify: "java --version 2>&1",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["openjdk-21-jdk"]),
          // Amazon ships Corretto in place of OpenJDK — `java-21-openjdk-devel` does not
          // exist on AL2023, so a Java build there installed nothing and then failed on a
          // missing `javac`.
          dnf: answered(
            isAmazon(ops.profile) ? ["java-21-amazon-corretto-devel"] : ["java-21-openjdk-devel"],
          ),
          // AL2 and CentOS 7 top out far below 21 (AL2's newest is
          // `java-1.8.0-openjdk-devel`). Installing Java 8 for a recipe that promises 21 is
          // the silent wrong answer, so name the release as the problem instead.
          yum: refused(
            "This host's release carries no OpenJDK 21 package — the newest it has is Java " +
              "8/11, and Openship will not install a JDK older than the toolchain asks for. " +
              "Use a newer OS release, or build in a container.",
          ),
          apk: answered(["openjdk21-jdk"]),
          brew: answered(["openjdk@21"]),
        }),
      ),
  },

  maven: {
    verify: "mvn -version",
    steps: (ops) => asRoot(ops.pkgInstall(["maven"])),
  },

  gradle: {
    verify: "gradle --version",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["gradle"]),
          dnf: refused(NO_GRADLE_RPM),
          yum: refused(NO_GRADLE_RPM),
          apk: answered(["gradle"]),
          brew: answered(["gradle"]),
        }),
      ),
  },

  dotnet: {
    verify: "dotnet --version",
    steps: (ops): ToolSteps => {
      // dotnet-install.sh resolves a glibc runtime id, so on musl it fetches a build that
      // cannot start. Alpine's own sdk package is musl-linked.
      if (ops.profile.libc === "musl") return asRoot(ops.pkgInstall(["dotnet8-sdk"]));
      if (ops.profile.packageManager === "brew") return asRoot(ops.pkgInstall(["dotnet"]));
      if (ops.profile.os !== "linux") {
        return refused(
          `Openship installs the .NET SDK on Linux, and on macOS through Homebrew. This ` +
            `host reports os=${ops.profile.os}.`,
        );
      }
      return asRoot(
        "curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh",
        `bash /tmp/dotnet-install.sh --channel ${DOTNET_CHANNEL} --install-dir /usr/local/share/dotnet`,
        "rm -f /tmp/dotnet-install.sh",
        "ln -sf /usr/local/share/dotnet/dotnet /usr/local/bin/dotnet",
      );
    },
  },

  elixir: {
    verify: "elixir --version 2>&1",
    steps: (ops) =>
      asRoot(
        ops.pkgInstallVariants({
          apt: answered(["erlang", "elixir"]),
          // Keyed on the distro, not the package manager, because the two disagree here:
          // Fedora carries elixir and erlang in its own repos, while AL2023 and Rocky 9
          // — same `dnf` — carry neither. Refusing all of dnf told a Fedora operator to go
          // enable EPEL for a package Fedora already has, and EPEL does not target Fedora
          // at all, so the advice was not just unnecessary but impossible to follow.
          //
          // This is the first production reader of `profile.distro`.
          dnf:
            ops.profile.distro === "fedora"
              ? answered(["erlang", "elixir"])
              : refused(NO_ELIXIR_RPM),
          yum: refused(NO_ELIXIR_RPM),
          apk: answered(["elixir", "erlang"]),
          brew: answered(["elixir"]),
        }),
      ),
  },
};

// ─── The catalog ─────────────────────────────────────────────────────────────

type InstallPlanFactory = (profile: EnvironmentProfile) => ToolchainInstallPlan;

const INSTALLS: Record<string, InstallPlanFactory> = Object.fromEntries(
  Object.entries(RECIPES).map(([tool, recipe]) => [
    tool,
    (profile: EnvironmentProfile): ToolchainInstallPlan => {
      // Not every recipe touches a command method — bun and bundler are pure `curl`/`gem`
      // — so the host gate has to be applied here rather than left to `envOps`, or a host
      // Openship refused would still get a toolchain installed on it.
      const gate = hostRefusal(profile);
      if (gate !== null) return refused(gate);

      const ops = envOps(profile);
      const steps = recipe.steps(ops);
      // Whether a `"root"` step is actually elevated is the installer's call, not the
      // plan's: it depends on the host (macOS must not), and the installer is the one
      // holding the executor to elevate. The plan states what each step needs.
      return steps.supported
        ? answered({ steps: steps.value, verifyCommand: recipe.verify })
        : steps;
    },
  ]),
);

export const toolchainCatalog = {
  /**
   * Check recipes — how to detect each tool and parse its version.
   *
   * Every tool named in `LANGUAGES[lang].requiredTools` must have an entry here.
   */
  checks: CHECKS as Record<string, ToolchainCheckEntry>,

  /**
   * Install plan factories — how to install each tool on a given host.
   *
   * Only `installable` tools have one. npm, cargo, javac and mix arrive with their
   * parent and say so through `providedBy`.
   */
  installs: INSTALLS,
};
