/**
 * What to RUN on one host — the only place in this package where a package manager,
 * an init system or a firewall is named inside a command string.
 *
 * `environment.ts` measures the host, `@repo/core/host-profile` is the vocabulary, and
 * this module is the behaviour. The split matters because behaviour was previously
 * authored wherever it was needed: five divergent per-package-manager tables, three
 * different systemd tests, two package-manager detectors, and a Docker installer that
 * was `curl get.docker.com | sh` for every Linux — a script that hard-refuses `amzn`,
 * `almalinux`, `ol` and `alpine`. Each of those sites had its own idea of what a host
 * outside its allowlist meant, and every one of them read it as "nothing to do".
 *
 * Two rules make that failure mode unrepresentable:
 *
 * 1. **`envOps` never takes a `CommandExecutor`.** It is `profile → strings`, so the
 *    whole surface is exhaustively table-testable against every distro fixture with no
 *    fakes and no host. `environment-ops.test.ts` does exactly that.
 * 2. **Every answer is an {@link Answer}** — a command list, or a reason. There is no
 *    third shape, so "unsupported" cannot be spelled `undefined` and a caller cannot
 *    read it as "skip this step". A refusal always names the host it is about.
 *
 * Adding a member to `SystemPackageManager` / `SystemServiceManager` / `SystemFirewall`
 * is a compile error in each table below, and the value type is a union that includes a
 * reason — so the error cannot be silenced with `undefined`, only by stating a command
 * or stating why there isn't one.
 */

import {
  type Answer,
  answered,
  type EnvironmentProfile,
  firewallAllowSteps,
  firewallManager,
  type FirewallManager,
  firewallPersists,
  type FirewallScope,
  refused,
  shellQuote,
  type SystemArch,
  type SystemPackageManager,
  type SystemServiceManager,
} from "@repo/core";

// ─── The answer shape ────────────────────────────────────────────────────────

/** Shell commands to run in order, or the reason there are none. Never empty when supported. */
export type Op = Answer<readonly string[]>;

/**
 * Steps → one command line.
 *
 * `&&` rather than `;` so a failed step aborts the rest: the alternative is
 * `apt-get update` failing and `apt-get install` then "succeeding" against a stale
 * index. Callers that stream output per step can iterate the steps instead.
 */
export function opScript(steps: readonly string[]): string {
  return steps.join(" && ");
}

/** An architecture a release artifact can exist for. `unknown` is not one. */
export type ReleaseArch = Exclude<SystemArch, "unknown">;

/**
 * The arch a downloaded artifact must match, or why there isn't one.
 *
 * Shared by `releaseArch()` and by every recipe in this module that builds an asset URL,
 * so the refusal an operator reads is the same sentence wherever the arch mattered.
 */
function releaseArchOf(profile: EnvironmentProfile): Answer<ReleaseArch> {
  return profile.arch === "unknown"
    ? refused(
        "This host's CPU architecture could not be determined, and Openship will not " +
          "default to amd64 — a release artifact for the wrong architecture installs " +
          "cleanly and then fails to execute.",
      )
    : answered(profile.arch);
}

/**
 * Openship's own state directory on a managed Linux host.
 *
 * A constant rather than a literal because three places spelled it: this module, the
 * remote journal's wrapper default, and apps/api's `OPENSHIP_DIR` — each with a comment
 * asking the next person to keep them in sync. Read it through `stateDir()`, which knows
 * about macOS; import it directly only where there is no profile to ask (a module-scope
 * default, an embedded shell script).
 */
export const HOST_STATE_DIR = "/root/.openship";

/**
 * Per-package-manager package names for one logical thing.
 *
 * Total over every real manager, because this is where the divergence lives: Python is
 * `python3 python3-pip python3-venv` on apt and `python3 python3-pip` on dnf, Ruby is
 * `ruby-full build-essential` vs `ruby ruby-devel`, and Gradle has no rpm at all. A
 * `Record<string, string>` let the last of those be a silent no-op; a total record of
 * `Answer`s makes "Gradle has no dnf package" a sentence someone had to write.
 */
export type PackageVariants = Readonly<
  Record<Exclude<SystemPackageManager, "none">, Answer<readonly string[]>>
>;

// ─── The surface ─────────────────────────────────────────────────────────────

/**
 * Facts that hold whether or not Openship can drive the host.
 *
 * Never gated. "This box runs firewalld" and "this box's home is /root" stay true on a
 * host we refuse to provision, and the operator-facing messages that explain the refusal
 * are built out of exactly these.
 */
export type HostFacts = {
  readonly profile: EnvironmentProfile;
  /** One line naming the host, for logs and for the tail of every refusal. */
  describe(): string;
  /** How an operator would enable sshd here. `ssh` on Debian, `sshd` elsewhere, and
   *  neither word on macOS — which is why this is a hint and not a unit name. */
  sshdEnableHint(): string;
  /** The firewall we could drive, or why we can't. `none`/`unknown` are not managers. */
  firewallManager(): Answer<FirewallManager>;
  /** A rule added here survives a reboot. False for raw iptables/nftables. */
  firewallPersists(): boolean;
  /** The LOGIN user's home — whose `authorized_keys` and dotfiles these are. */
  home(): string;
  /**
   * Where Openship keeps its own state on this host.
   *
   * On Linux this is root's, NOT `home()`: every host operation runs elevated, and
   * the files are root-owned by contract (mail-state.json is root-only readable).
   * Deriving it from the login user would split state the moment someone connected
   * as a sudo user rather than root, leaving the existing directory unread.
   */
  stateDir(): string;
  /**
   * Scratch Openship owns on this host, writable by whoever we logged in AS.
   *
   * Distinct from `stateDir()` because the two have different writers. `stateDir()` is
   * root-owned by contract and reached through an elevated executor; the remote journal
   * deploys its wrapper over **SFTP**, which has no shell and therefore cannot be
   * elevated at all — so a root-anchored base is unwritable on any host we log into as
   * a non-root user, no matter how much sudo that user has.
   *
   * For a root login `home` IS `/root`, so this is byte-identical to `stateDir()` on
   * every host that already works today. It only diverges where the old constant failed.
   */
  scratchDir(): string;
  /**
   * A host-wide install here must run as root.
   *
   * True on every managed Linux host: packages land under /usr, units under /etc, and a
   * language runtime is linked into /usr/local/bin. False on macOS, where the target is
   * the operator's own machine and Homebrew REFUSES to run under sudo — elevating there
   * turns a working install into an error, which is why this is a fact rather than an
   * assumption each installer makes for itself.
   */
  installsNeedRoot(): boolean;
};

/**
 * Things to run on the host. Every member is gated on `profile.supported`.
 *
 * Gated wholesale in {@link envOps} rather than per method: a method added here is
 * refused on an unsupported host automatically, with no discipline required from
 * whoever adds it.
 */
export type HostCommands = {
  pkgInstall(packages: readonly string[]): Op;
  /** Install one logical thing whose package name differs per manager. */
  pkgInstallVariants(variants: PackageVariants): Op;
  pkgRemove(packages: readonly string[]): Op;
  /** Print the installable version of `pkg`; the caller parses per manager. */
  pkgAvailableVersion(pkg: string): Op;
  serviceEnableStart(unit: string): Op;
  /** Exit-code semantics: 0 iff the unit is running. Prints nothing. */
  serviceIsActive(unit: string): Op;
  firewallAllow(scope: FirewallScope): Op;
  dockerInstall(): Op;
  dockerStart(): Op;
  releaseArch(): Answer<ReleaseArch>;
};

export type EnvOps = HostFacts & HostCommands;

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * A package name safe to interpolate.
 *
 * Validated rather than quoted, for the reason `host-firewall.ts` gives: these names
 * also appear in operator-facing text and in the `apt-cache policy` output the version
 * parsers match against. Nothing that matches can carry a shell metacharacter.
 */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+@-]*$/;

function joinPackages(packages: readonly string[]): Answer<string> {
  if (packages.length === 0) {
    return refused("No packages were named, so there is nothing to run.");
  }
  const bad = packages.find((name) => !PACKAGE_NAME.test(name));
  if (bad !== undefined) {
    return refused(`${JSON.stringify(bad)} is not a package name.`);
  }
  return answered(packages.join(" "));
}

// ─── Package manager ─────────────────────────────────────────────────────────

type PkgRule = (names: string) => Op;

const INSTALL: Readonly<Record<SystemPackageManager, PkgRule>> = {
  // `update` first because an install against a stale index fails on a
  // just-provisioned box; `-qq` because this output streams into the UI.
  apt: (names) => answered(["apt-get update -qq", `apt-get install -y -qq ${names}`]),
  dnf: (names) => answered([`dnf install -y ${names}`]),
  yum: (names) => answered([`yum install -y ${names}`]),
  apk: (names) => answered([`apk add --no-cache ${names}`]),
  brew: (names) => answered([`brew install ${names}`]),
  none: (names) =>
    refused(
      `No package manager is available to install ${names} — Openship looked for ` +
        `apt-get, dnf, yum, apk and brew and found none.`,
    ),
};

const REMOVE: Readonly<Record<SystemPackageManager, PkgRule>> = {
  // `purge` + `autoremove`, matching what the uninstallers did before this table: a
  // component Openship installed should leave no config behind when removed.
  apt: (names) => answered([`apt-get purge -y -qq ${names}`, "apt-get autoremove -y -qq"]),
  dnf: (names) => answered([`dnf remove -y ${names}`]),
  yum: (names) => answered([`yum remove -y ${names}`]),
  apk: (names) => answered([`apk del ${names}`]),
  brew: (names) => answered([`brew uninstall --force ${names}`]),
  none: (names) =>
    refused(`No package manager is available to remove ${names}.`),
};

/**
 * Print the installable version of a package.
 *
 * The commands are the ones `available-version.ts` already issued; its per-manager
 * output parsers stay where they are, because parsing `apt-cache policy` is knowledge
 * about apt's output rather than about this host.
 */
const AVAILABLE_VERSION: Readonly<Record<SystemPackageManager, PkgRule>> = {
  apt: (names) => answered([`apt-cache policy ${names} 2>/dev/null`]),
  dnf: (names) => answered([`dnf -q --cacheonly list available ${names} 2>/dev/null | tail -n1`]),
  yum: (names) => answered([`yum -q --cacheonly list available ${names} 2>/dev/null | tail -n1`]),
  apk: (names) => answered([`apk policy ${names} 2>/dev/null`]),
  brew: (names) =>
    refused(
      `Openship does not read Homebrew's available version for ${names} — it reports the ` +
        `installed version only on macOS.`,
    ),
  none: (names) =>
    refused(`No package manager is available to look up an installable version of ${names}.`),
};

// ─── Service manager ─────────────────────────────────────────────────────────

type ServiceRules = {
  enableStart(unit: string): Op;
  isActive(unit: string): Op;
};

/** Every verb refuses with one reason — for the managers we don't drive. */
function noServiceManager(reason: string): ServiceRules {
  const refuse = () => refused(reason);
  return { enableStart: refuse, isActive: refuse };
}

const SERVICE: Readonly<Record<SystemServiceManager, ServiceRules>> = {
  systemd: {
    enableStart: (unit) => answered([`systemctl enable --now ${unit}`]),
    // `--quiet` because the caller wants the exit code, and a unit name echoed onto
    // stdout is the kind of thing a `!output` check reads as "running".
    isActive: (unit) => answered([`systemctl is-active --quiet ${unit}`]),
  },

  openrc: {
    // Two steps, not one: `rc-update add` is persistence and `rc-service start` is now.
    // OpenRC has no `--now`, which is why Alpine used to get a start command of
    // `undefined` from a table that assumed systemd.
    enableStart: (unit) => answered([`rc-update add ${unit} default`, `rc-service ${unit} start`]),
    // Exits 0 started / 3 stopped, and prints to stdout — silenced so the contract
    // matches systemd's `is-active --quiet`.
    isActive: (unit) => answered([`rc-service ${unit} status >/dev/null 2>&1`]),
  },

  launchd: noServiceManager(
    "This host runs launchd, and Openship does not manage macOS system services — " +
      "launchd jobs are addressed by label rather than by unit name, and starting or " +
      "stopping one is the operator's call.",
  ),

  none: noServiceManager(
    "This host has no service manager Openship can drive (no running systemd, no " +
      "OpenRC, no launchd), so services cannot be started, stopped or inspected. A " +
      "container started without an init system is the usual cause.",
  ),
};

// ─── Docker ──────────────────────────────────────────────────────────────────

/**
 * The os-release IDs `get.docker.com` accepts.
 *
 * Verified against the script's own source: it sets `lsb_dist` from `ID` verbatim with no
 * `ID_LIKE` fallback, then switches on it, and its `*)` arm exits 1 with
 * `ERROR: Unsupported distribution`. So `amzn` was always going to fail here.
 *
 * The set is narrower than the script's true reach, and deliberately: `check_forked` runs
 * BEFORE that switch and rewrites `lsb_dist` from `lsb_release -a -u`, falling back to
 * forcing `debian` for any readable `/etc/debian_version`. A Debian derivative therefore
 * does reach the apt arm — but the codename it lands on is one the script derives at
 * runtime, and Docker's apt repo 404s on a suite it doesn't publish. Listing only the IDs
 * whose suite we can name from os-release keeps that guess out; the derivative arm below
 * takes the distro's own package instead, which needs no suite at all.
 */
const GET_DOCKER_IDS: ReadonlySet<string> = new Set([
  "ubuntu",
  "debian",
  "raspbian",
  "centos",
  "fedora",
  "rhel",
  "rocky",
]);

const DOCKER_CE_REPO_FILE = "/etc/yum.repos.d/docker-ce.repo";

/**
 * Docker CE's rpm repo, for the RHEL-family IDs `get.docker.com` won't take.
 *
 * The vendor file interpolates `$releasever`, and that is the hazard. The `centos` tree
 * publishes only major-version directories, so a host where `$releasever` expands to `9.4`
 * requests `/linux/centos/9.4/$basearch/stable` and gets a hard 404 — unlike
 * `/linux/rhel/9.4/…`, which 301s to the major. Probing says the opposite of the truth:
 * `/linux/centos/9.4/` answers 200, but that is an S3 redirect covering the index page
 * only. `alma`, `rocky` and `oracle` have no dotted redirect either, and `centos` is the
 * one tree with a 7 in it — which is why this stays on centos rather than picking a tree
 * per rebuild.
 *
 * Every el9 rebuild checked expands `$releasever` to the major on its own and ships no
 * `/etc/dnf/vars/releasever`, so the default path works. What reaches the 404 is an image
 * that pins a point release there — kickstart and subscription-style templates do — and
 * nothing on the host says so. So the major we already detected is substituted into the
 * file we just wrote, and nowhere else: `--releasever` on the transaction would repoint
 * the BASE repos of exactly the host that pinned them on purpose.
 */
function dockerCeRepoSteps(profile: EnvironmentProfile): readonly string[] {
  const write =
    "curl -fsSL https://download.docker.com/linux/centos/docker-ce.repo " +
    `-o ${DOCKER_CE_REPO_FILE}`;
  // Digits only by construction, so it needs no quoting of its own. A host with no
  // VERSION_ID keeps `$releasever` — today's behaviour, and right wherever one is reported.
  const major = /^(\d+)/.exec(profile.versionId ?? "")?.[1];
  if (!major) return [write];
  return [write, `sed -i 's|\\$releasever|${major}|g' ${DOCKER_CE_REPO_FILE}`];
}

const DOCKER_CE_PACKAGES =
  "docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin";

/**
 * Compose v2 for the hosts whose own repos carry no plugin package.
 *
 * `docker-compose-plugin` exists only in Docker's own apt/rpm repos, and every deploy path
 * in this product runs `docker compose` — so an engine installed from anywhere else lands
 * a host that provisions green and fails its first deploy with "'compose' is not a docker
 * command". Two arms below are in that position and neither has a package name to reach for:
 *
 * - Amazon Linux: `docker-compose-plugin` is in no AL2 or AL2023 repo (the package request
 *   is still open), and `download.docker.com/linux/` has no `amazonlinux` directory to add.
 * - The Debian-family fallback: it installs the DISTRO's `docker.io`, and the archive's
 *   plugin is `docker-compose-v2` on Ubuntu derivatives (universe, jammy-updates onward),
 *   `docker-compose` ≥ 2 on Debian trixie, and nothing at all on bookworm. Picking between
 *   those turns on the upstream suite and on whether universe is enabled, neither of which
 *   this arm acts on today — see the `debian` case for what is known and why it waits.
 *
 * So both take the binary Docker documents for a system-wide manual install. Pinned rather
 * than `releases/latest` for the reason every other recipe here is pinned: a provisioning
 * step whose payload changes under you cannot be reproduced from a bug report.
 */
const COMPOSE_PLUGIN_VERSION = "v5.4.0";
/** The CLI's system-wide plugin directory — the one Docker's manual-install docs name. */
const COMPOSE_PLUGIN_DIR = "/usr/local/lib/docker/cli-plugins";
const COMPOSE_PLUGIN_PATH = `${COMPOSE_PLUGIN_DIR}/docker-compose`;

/** Release asset suffix per arch: Docker names these after `uname -m`, not GOARCH. */
const COMPOSE_PLUGIN_ASSET: Readonly<Record<ReleaseArch, string>> = {
  amd64: "x86_64",
  arm64: "aarch64",
};

/** An engine install plus the plugin, so no arm can answer with half of `docker compose`. */
function withComposePlugin(profile: EnvironmentProfile, engine: readonly string[]): Op {
  const arch = releaseArchOf(profile);
  if (!arch.supported) return arch;
  const asset = `docker-compose-linux-${COMPOSE_PLUGIN_ASSET[arch.value]}`;
  return answered([
    ...engine,
    `mkdir -p ${COMPOSE_PLUGIN_DIR}`,
    `curl -fsSL https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/${asset} -o ${COMPOSE_PLUGIN_PATH}`,
    `chmod 0755 ${COMPOSE_PLUGIN_PATH}`,
  ]);
}

function dockerInstallSteps(profile: EnvironmentProfile): Op {
  if (profile.os === "darwin") {
    return refused(
      "Openship does not install Docker on macOS — Docker Desktop (or OrbStack/Colima) " +
        "is a GUI application an operator installs and licenses themselves.",
    );
  }
  if (profile.os !== "linux") {
    return refused("Docker can only be installed on a Linux or macOS host.");
  }

  const id = profile.distroId?.trim().toLowerCase() ?? "";
  if (GET_DOCKER_IDS.has(id)) {
    // The script pulls `docker-compose-plugin` itself on both its apt and its rpm paths,
    // so these hosts need no second step; the arms below are the ones that do. That holds
    // because both plugin lines sit behind `version_gte "20.10"`, and `version_gte` returns
    // true when `$VERSION` is unset — so it is true only while we invoke the script BARE.
    // Passing a VERSION to pin an engine would re-gate the plugin and quietly make this
    // arm the thing {@link withComposePlugin} exists to prevent.
    //
    // The point-release hazard {@link dockerCeRepoSteps} pins is NOT closed here, on
    // purpose: the script fetches `/linux/$ID/docker-ce.repo` and leaves `$releasever` to
    // dnf, so a host pinning one in /etc/dnf/vars fails inside the vendor script — and for
    // `rocky` there is no dotted-path redirect to save it, where `rhel` gets one. Pinning it
    // would mean replacing the vendor path with our own recipe, losing dnf5-vs-dnf syntax,
    // channel handling and makecache to cover an image shape nothing on the host declares.
    return answered(["curl -fsSL https://get.docker.com | sh"]);
  }

  switch (profile.distroFamily) {
    case "rhel":
      // Amazon Linux ships Docker itself and is not in Docker CE's repo layout at all:
      // AL2023 has it in the core `amazonlinux` repo, AL2 only behind extras. The two
      // are told apart by package manager (dnf vs yum), not by parsing VERSION_ID.
      if (id === "amzn") {
        return withComposePlugin(
          profile,
          profile.packageManager === "yum"
            ? // `amazon-linux-extras` exits 13 with "Installation failed" AFTER yum has
              // printed "Complete!" and left dockerd on disk — seen once in four runs
              // against a real amazonlinux:2. `opScript` joins with `&&`, so that exit
              // aborted the plugin steps below and produced the engine-without-`docker
              // compose` host {@link withComposePlugin} exists to prevent. Tolerate a
              // non-zero exit only when the binary is actually there; a real failure has
              // nothing to find and still aborts. Braced so it stays one step if a step
              // is ever prepended — `&&` and `||` bind equally and left-associatively.
              ["{ amazon-linux-extras install -y docker || command -v docker >/dev/null 2>&1; }"]
            : ["dnf install -y docker"],
        );
      }
      // Alma/Oracle and anything else that reached `rhel` via ID_LIKE. The `centos`
      // repo is the one Docker publishes for the rebuilds; adding the .repo file
      // directly works on dnf4 and dnf5 alike, where `dnf config-manager --add-repo`
      // changed syntax in Fedora 41 and needs dnf-plugins-core installed first.
      return answered([
        ...dockerCeRepoSteps(profile),
        `${profile.packageManager} install -y ${DOCKER_CE_PACKAGES}`,
      ]);

    case "debian":
      // Mint, Pop!_OS and friends. Not because `get.docker.com` refuses them — it
      // normalizes them (see {@link GET_DOCKER_IDS}) — but because the suite it derives at
      // runtime is one we cannot check first, and Docker's apt repo 404s on a suite it does
      // not publish.
      //
      // The suite is no longer the unknown it was. Every derivative checked — Mint
      // 21.3/22/22.1/22.2, Pop 22.04/24.04, Zorin 17, elementary 7/8 — ships
      // UBUNTU_CODENAME set to the upstream Ubuntu codename, which IS a published suite,
      // while VERSION_CODENAME is the distro's own name (`virginia`, `wilma`, `circe`) and
      // is a suite nowhere; Docker's own documented command reads them in that order, and
      // Mint mints a fresh VERSION_CODENAME per point release, so the derivative name could
      // never have been enumerated anyway. What is unverified is the OUTCOME of authoring
      // an apt source here against a real derivative, and the trade is lopsided: this path
      // provisions a working engine today, so a wrong recipe turns hosts that work into
      // hosts with no Docker in exchange for a newer one. Rewire it from a host, not from a
      // repo listing.
      //
      // So this stays a deliberate downgrade: the distro's `docker.io` is older than
      // docker-ce but real, and MIN_DOCKER_VERSION gates it. It carries no compose plugin
      // under any name we can derive here — see {@link COMPOSE_PLUGIN_VERSION}.
      return withComposePlugin(profile, [
        "apt-get update -qq",
        "apt-get install -y -qq docker.io",
      ]);

    case "alpine":
      // `docker-compose` does not exist in Alpine; the v2 plugin is `docker-cli-compose`.
      // `docker-openrc` comes in automatically via the package's `install_if` when
      // OpenRC is present, and is what supplies `rc-service docker`.
      return answered(["apk add --no-cache docker docker-cli docker-cli-compose"]);

    case "suse":
    case "arch":
    case "unknown":
      return refused(
        `Openship has no Docker install path for this host (os-release ID=` +
          `${JSON.stringify(profile.distroId ?? "")}, family ${profile.distroFamily}).`,
      );
  }
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function homeOf(profile: EnvironmentProfile): string {
  const home = profile.home.trim();
  if (home) return home;
  if (profile.isRoot) return "/root";
  const user = profile.loginUser.trim();
  return user ? `/home/${user}` : "/root";
}

function describeProfile(profile: EnvironmentProfile): string {
  const name = profile.prettyName?.trim() || profile.distroId?.trim() || profile.os;
  const parts = [
    name,
    `${profile.os}/${profile.arch}`,
    `pm=${profile.packageManager}`,
    `init=${profile.serviceManager}`,
    `firewall=${profile.firewall}`,
    profile.isRoot ? "root" : profile.canSudo ? `${profile.loginUser}+sudo` : profile.loginUser,
  ];
  if (profile.isContainer) parts.push("container");
  return parts.filter(Boolean).join(" · ");
}

function sshdEnableHintFor(profile: EnvironmentProfile): string {
  switch (profile.serviceManager) {
    case "systemd":
      // Debian and Ubuntu name the unit `ssh`; every RHEL-family distro and Alpine name
      // it `sshd`. This was hardcoded to `ssh` in the one place it was rendered, which
      // is a command that does nothing on the RHEL hosts most likely to need it.
      return profile.distroFamily === "debian"
        ? "sudo systemctl enable --now ssh"
        : "sudo systemctl enable --now sshd";
    case "openrc":
      return "sudo rc-update add sshd default && sudo rc-service sshd start";
    case "launchd":
      return "sudo systemsetup -setremotelogin on";
    case "none":
      return "start this host's SSH server (no service manager was detected, so start it however this host does)";
  }
}

function hostFacts(profile: EnvironmentProfile): HostFacts {
  const home = homeOf(profile);
  return {
    profile,
    describe: () => describeProfile(profile),
    sshdEnableHint: () => sshdEnableHintFor(profile),
    // Both delegate: these are facts about a `SystemFirewall`, not about a profile, and
    // the CLI reads them off a locally-measured firewall with no profile in hand.
    firewallManager: () => firewallManager(profile.firewall),
    firewallPersists: () => firewallPersists(profile.firewall),
    home: () => home,
    // macOS has no /root to own anything, and there it is a local target rather than
    // a provisioned server, so the invoking user's home is the only sensible anchor.
    stateDir: () => (profile.os === "darwin" ? `${home}/.openship` : HOST_STATE_DIR),
    scratchDir: () => `${home}/.openship`,
    installsNeedRoot: () => profile.os !== "darwin",
  };
}

function withPackages(packages: readonly string[], rule: PkgRule): Op {
  const names = joinPackages(packages);
  return names.supported ? rule(names.value) : names;
}

function hostCommands(profile: EnvironmentProfile): HostCommands {
  const pm = profile.packageManager;
  const service = SERVICE[profile.serviceManager];
  const unit = (name: string) => shellQuote(name);

  const firewallScoped = (
    scope: FirewallScope,
    steps: (manager: FirewallManager, scope: FirewallScope) => Op,
  ): Op => {
    const manager = firewallManager(profile.firewall);
    return manager.supported ? steps(manager.value, scope) : manager;
  };

  return {
    pkgInstall: (packages) => withPackages(packages, INSTALL[pm]),

    pkgInstallVariants: (variants) => {
      if (pm === "none") return INSTALL.none("this package");
      const chosen = variants[pm];
      return chosen.supported ? withPackages(chosen.value, INSTALL[pm]) : chosen;
    },

    pkgRemove: (packages) => withPackages(packages, REMOVE[pm]),

    pkgAvailableVersion: (pkg) => withPackages([pkg], AVAILABLE_VERSION[pm]),

    // Unit names are quoted rather than validated: unlike package names they are
    // data-derived (a project slug, a unit read off a `systemctl list-units` scan), so
    // the guarantee has to hold for a string nobody vetted.
    serviceEnableStart: (name) => service.enableStart(unit(name)),
    serviceIsActive: (name) => service.isActive(unit(name)),

    firewallAllow: (scope) => firewallScoped(scope, firewallAllowSteps),

    dockerInstall: () => dockerInstallSteps(profile),

    // Through `unit()` like every other unit name, so there is one path to a service verb
    // rather than one path plus an exception that happens to be safe today.
    dockerStart: () => service.enableStart(unit("docker")),

    releaseArch: () => releaseArchOf(profile),
  };
}

/**
 * Any function returning an {@link Answer}.
 *
 * `never[]` rather than `any[]` so it stays sound under `strictFunctionTypes` while
 * still accepting every method on {@link HostCommands}.
 */
type AnswerFn = (...args: never[]) => Answer<unknown>;

/**
 * Rewrite every refusal in a command set through `onRefusal`.
 *
 * Keyed off `Object.keys` on purpose: a method added to {@link HostCommands} is covered
 * the moment it exists, with no list here to keep in step. That is the whole mechanism
 * behind "one gate, no per-method forgetting".
 */
function mapRefusals<T extends Record<string, AnswerFn>>(
  commands: T,
  onRefusal: (reason: string) => string,
  gate: string | null,
): T {
  const out: Record<string, AnswerFn> = {};
  for (const name of Object.keys(commands)) {
    const fn = commands[name] as AnswerFn;
    out[name] = ((...args: never[]) => {
      if (gate !== null) return refused(gate);
      const answer = fn(...args);
      return answer.supported ? answer : refused(onRefusal(answer.reason));
    }) as AnswerFn;
  }
  return out as unknown as T;
}

/**
 * The one reason nothing may run on this host, or `null` when something may.
 *
 * Exported because a caller can assemble a plan without touching a single command method
 * — `curl … | bash` needs no package manager — and such a plan still must not run on a
 * host Openship has refused. Sharing this function is what keeps that check from becoming
 * a second, drifting opinion about which hosts are drivable.
 */
export function hostRefusal(profile: EnvironmentProfile): string | null {
  if (profile.supported) return null;
  // Including the case the verdict couldn't articulate, which should be unreachable and
  // is still not allowed to be silent.
  const reason =
    profile.unsupportedReason ??
    "Openship cannot drive this host, and the detector recorded no reason.";
  return `${reason} (host: ${describeProfile(profile)})`;
}

/**
 * The commands for one host.
 *
 * Pure. Call it as often as you like; it measures nothing and caches nothing, and the
 * profile it takes is the one `resolveEnvironment` already cached.
 */
export function envOps(profile: EnvironmentProfile): EnvOps {
  const facts = hostFacts(profile);
  const label = describeProfile(profile);
  const withHost = (reason: string) => `${reason} (host: ${label})`;

  return { ...facts, ...mapRefusals(hostCommands(profile), withHost, hostRefusal(profile)) };
}
