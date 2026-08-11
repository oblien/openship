/**
 * What one target host IS — the facts, and nothing about what to do with them.
 *
 * The commands that act on these facts live in `@repo/adapters`
 * (`system/environment-ops.ts`), and the detection that measures them lives in
 * `system/environment.ts`. This module is the vocabulary both sides share, plus the
 * pure classification that turns `/etc/os-release` text into it.
 *
 * It lives in @repo/core rather than @repo/adapters for the reason `host-channel.ts`
 * gives: the dashboard consumes the firewall union and cannot import the adapters
 * (ssh/docker code, server-only). Keeping the union in one place is what makes
 * exhaustiveness real rather than per-package theatre — `hostFirewallRule` and the
 * detector that feeds it have to agree on the member list or one of them is guessing.
 *
 * Isomorphic: no `node:*`, no measuring. Facts and shapes only.
 */

// ─── The unions ──────────────────────────────────────────────────────────────

export type SystemOs = "linux" | "darwin" | "unknown";

/** Release-artifact spelling (amd64/arm64), not uname's (x86_64/aarch64). */
export type SystemArch = "amd64" | "arm64" | "unknown";

/**
 * The OS package manager.
 *
 * Not to be confused with the JS `packageManager` (npm/pnpm/bun) that
 * `workspaces/*.ts` and `stack-detector.ts` mean by the same word. Different axis,
 * same noun; renaming either would break more than it clarifies.
 */
export type SystemPackageManager = "apt" | "dnf" | "yum" | "apk" | "brew" | "none";

export type SystemServiceManager = "systemd" | "openrc" | "launchd" | "none";

/**
 * Which firewall the host runs.
 *
 * `none` and `unknown` are not the same thing and the rule differs: `none` means we
 * looked and found no manager (so the rule is raw iptables, with its caveat), while
 * `unknown` means we couldn't look — the API runs in a container and cannot see the
 * host's package list, so it has to offer both forms.
 *
 * `iptables` is distinct from `none`: rules exist and are being enforced by something
 * that isn't a manager we can drive, so a rule we add may not survive a reboot.
 */
export type SystemFirewall =
  | "ufw"
  | "firewalld"
  | "nftables"
  | "iptables"
  | "none"
  | "unknown";

/**
 * Every distro ID we recognize by name — including the ones we refuse to drive.
 *
 * Naming a distro we won't provision is the point rather than an oversight: it turns
 * "unsupported host" into "Openship doesn't drive openSUSE's zypper", which an
 * operator can act on. A distro absent from this union resolves to `unknown` and is
 * refused with the observed ID quoted back.
 */
export type LinuxDistro =
  | "ubuntu"
  | "debian"
  | "rhel"
  | "centos"
  | "fedora"
  | "rocky"
  | "almalinux"
  | "oracle"
  | "amzn"
  | "alpine"
  // Recognized so the refusal can be specific. No commands are wired for these.
  | "opensuse"
  | "arch"
  | "unknown";

/**
 * The unit that actually selects behaviour.
 *
 * Rocky, Alma, Oracle and Amazon Linux are byte-identical to RHEL for every command
 * this codebase issues, so keying commands on `distro` means re-deciding the same
 * thing per vendor and getting it wrong for whichever one shipped last.
 */
export type DistroFamily = "debian" | "rhel" | "alpine" | "suse" | "arch" | "unknown";

export type SystemLibc = "glibc" | "musl" | "unknown";

/** `absent` = no `getenforce`, i.e. SELinux isn't installed (not merely off). */
export type SystemSelinux = "enforcing" | "permissive" | "disabled" | "absent";

// ─── The profile ─────────────────────────────────────────────────────────────

/**
 * One resolved host. Every field is required on purpose: an optional field reads as
 * "unknown" at each call site independently, which is how the distro gate at
 * `modules/reconcile.ts` came to skip provisioning steps silently.
 */
export interface EnvironmentProfile {
  // ── identity ──
  os: SystemOs;
  /** `uname -s` verbatim. The only thing that can name an OS we don't carry. */
  osRaw: string | null;
  arch: SystemArch;
  /** `uname -m` verbatim. The only thing that can name an architecture we don't carry. */
  archRaw: string | null;
  /** `null` on non-Linux, where the concept doesn't apply. */
  distro: LinuxDistro | null;
  distroFamily: DistroFamily;
  /** os-release `ID` verbatim. The only thing that can name a distro we don't know. */
  distroId: string | null;
  /** os-release `VERSION_ID` verbatim — "2023", "2", "9.4", "24.04". */
  versionId: string | null;
  /** os-release `PRETTY_NAME`. Operator-facing text only; never branch on it. */
  prettyName: string | null;

  // ── behaviour selectors ──
  packageManager: SystemPackageManager;
  serviceManager: SystemServiceManager;
  /** The *active* firewall, not merely an installed one. */
  firewall: SystemFirewall;
  libc: SystemLibc;
  selinux: SystemSelinux;
  /** PID 1 isn't the box's init — Docker/LXC/WSL. Affects whether services are ours to drive. */
  isContainer: boolean;

  // ── the login user ──
  /** The SSH/login user is uid 0. Privileged commands need this — or `canSudo`. */
  isRoot: boolean;
  /** Non-root but has passwordless sudo. Meaningless when `isRoot`. */
  canSudo: boolean;
  loginUser: string;
  home: string;
  /**
   * An sshd `ForceCommand` / `authorized_keys command=` is intercepting every exec.
   *
   * The AWS AMI ships one on root's key that prints `Please login as the user
   * "ec2-user"` and exits 142. Every command we send runs that instead, so the box
   * looks reachable and answers nothing — which is the shape the Amazon Linux
   * `socket hang up` arrived in.
   */
  forcedCommand: string | null;
  /**
   * The probe never ran, or its answer never came back: a timeout, a channel torn down
   * mid-command, no shell at all.
   *
   * Mutually exclusive with `forcedCommand`, and the distinction is load-bearing — that
   * text is the *host's* output, this text is *our* diagnostic. Reading one as the other
   * turns a slow minute on a healthy box into "your sshd runs a forced command", quoting
   * our own probe script back at the operator as if the host had said it.
   */
  probeError: string | null;

  // ── the verdict ──
  /** Openship can drive this host. When false, `unsupportedReason` says why. */
  supported: boolean;
  unsupportedReason: string | null;
}

// ─── Classification (pure) ───────────────────────────────────────────────────

/**
 * `distro → family`, total over every distro EXCEPT `unknown`.
 *
 * `unknown` is excluded deliberately: it forces the `ID_LIKE` path to be the only
 * route out of an unrecognized ID, and leaves no entry that could absorb a newly
 * added distro silently. Adding a member to `LinuxDistro` without a family here is a
 * compile error.
 */
export const FAMILY_BY_DISTRO: Record<Exclude<LinuxDistro, "unknown">, DistroFamily> = {
  ubuntu: "debian",
  debian: "debian",
  rhel: "rhel",
  centos: "rhel",
  fedora: "rhel",
  rocky: "rhel",
  almalinux: "rhel",
  oracle: "rhel",
  amzn: "rhel",
  alpine: "alpine",
  opensuse: "suse",
  arch: "arch",
};

/**
 * os-release `ID` → the distro we know it as.
 *
 * Open-ended by nature (any string can appear), so this is a lookup rather than a
 * total record. Unrecognized IDs fall to `ID_LIKE`.
 */
const DISTRO_BY_ID: Readonly<Record<string, LinuxDistro>> = {
  ubuntu: "ubuntu",
  debian: "debian",
  rhel: "rhel",
  "rhel server": "rhel",
  redhat: "rhel",
  centos: "centos",
  fedora: "fedora",
  rocky: "rocky",
  almalinux: "almalinux",
  alma: "almalinux",
  ol: "oracle", // Oracle Linux. The ID that looks like nothing.
  oracle: "oracle",
  amzn: "amzn",
  alpine: "alpine",
  opensuse: "opensuse",
  "opensuse-leap": "opensuse",
  "opensuse-tumbleweed": "opensuse",
  sles: "opensuse",
  arch: "arch",
  archarm: "arch",
};

/**
 * An `ID_LIKE` token → family, for distros we don't name.
 *
 * This is the single line that would have kept Amazon Linux out of the `unknown`
 * cascade: `ID=amzn` isn't in anyone's allowlist, but `ID_LIKE=fedora` has been
 * sitting in its os-release the whole time, unread.
 */
const FAMILY_BY_ID_LIKE: Readonly<Record<string, DistroFamily>> = {
  debian: "debian",
  ubuntu: "debian",
  rhel: "rhel",
  fedora: "rhel",
  centos: "rhel",
  "rhel-fedora": "rhel",
  alpine: "alpine",
  suse: "suse",
  opensuse: "suse",
  arch: "arch",
};

/** Parse `KEY=value` / `KEY="value"` os-release text. Unknown keys are kept. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0];
      if (value.endsWith(quote)) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface DistroClassification {
  distro: LinuxDistro;
  family: DistroFamily;
}

/**
 * `ID` + `ID_LIKE` → distro and family.
 *
 * Direct ID match first; on a miss, the first `ID_LIKE` token that maps wins.
 * `ID_LIKE` is ordered most-specific-first by convention (Amazon Linux 2 ships
 * `"centos rhel fedora"`), so first-match is the right read.
 */
export function classifyDistro(
  id: string | null | undefined,
  idLike?: string | null,
): DistroClassification {
  const normalizedId = id?.trim().toLowerCase() ?? "";
  const distro = DISTRO_BY_ID[normalizedId] ?? "unknown";
  if (distro !== "unknown") return { distro, family: FAMILY_BY_DISTRO[distro] };

  for (const token of (idLike ?? "").trim().toLowerCase().split(/\s+/)) {
    const family = token ? FAMILY_BY_ID_LIKE[token] : undefined;
    if (family) return { distro: "unknown", family };
  }
  return { distro: "unknown", family: "unknown" };
}

export function parseSystemOs(uname: string | null | undefined): SystemOs {
  const value = uname?.trim().toLowerCase();
  if (value === "linux") return "linux";
  if (value === "darwin") return "darwin";
  return "unknown";
}

/**
 * uname's machine → release-artifact arch.
 *
 * Anything unrecognized is `unknown`, never amd64. A silent amd64 default is how
 * `toolchain/catalog.ts` came to hand an x86_64 Go tarball to hosts that can't run it.
 */
export function parseSystemArch(uname: string | null | undefined): SystemArch {
  const value = uname?.trim().toLowerCase();
  if (!value) return "unknown";
  if (["x86_64", "amd64", "x64"].includes(value)) return "amd64";
  if (["aarch64", "arm64", "armv8l"].includes(value)) return "arm64";
  return "unknown";
}

// ─── The verdict (pure) ──────────────────────────────────────────────────────

/** The facts the support verdict depends on. A subset of the profile, so it can be reused. */
export interface HostSupportFacts {
  os: SystemOs;
  osRaw: string | null;
  arch: SystemArch;
  archRaw: string | null;
  distroId: string | null;
  distroFamily: DistroFamily;
  packageManager: SystemPackageManager;
  forcedCommand: string | null;
  probeError: string | null;
}

export interface HostSupportVerdict {
  supported: boolean;
  unsupportedReason: string | null;
}

const SUPPORTED = { supported: true, unsupportedReason: null } as const;

function refuse(reason: string): HostSupportVerdict {
  return { supported: false, unsupportedReason: reason };
}

/**
 * Can Openship drive this host?
 *
 * Ordered most-fundamental first so the reason names the root fault rather than a
 * downstream symptom — a forced command makes every other probe meaningless, so it
 * has to be reported before "no package manager".
 *
 * Every refusal quotes the observed fact. A generic "unsupported host" tells an
 * operator nothing they can act on, and this function is the only thing standing
 * between them and a deploy that fails somewhere deep in provisioning instead.
 */
export function assessHostSupport(facts: HostSupportFacts): HostSupportVerdict {
  // Before the forced-command check, because it is the one case where we hold no
  // observation at all. Collapsing it into `forcedCommand` blamed the operator's sshd for
  // a probe that merely timed out — and quoted our own script as the thing the host said.
  if (facts.probeError) {
    return refuse(
      `Openship could not measure this host: the probe never finished, so nothing below is ` +
        `a fact about the box. A loaded machine, a dropped SSH channel or a shell that ` +
        // "Openship's own" and not "it reported", because this string is OUR diagnostic
        // about a host that said nothing — attributing it to the box is how a timeout on
        // our own probe script got quoted back at the operator as the host's answer.
        `cannot run a script all look like this. Openship's own diagnostic: ` +
        `${JSON.stringify(facts.probeError)}`,
    );
  }

  if (facts.forcedCommand) {
    // Worded to be true of both causes, because the observation cannot tell them apart:
    // an sshd `ForceCommand` / `command=` running instead of ours, or a login shell that
    // can't run the script at all. Either way the box answered something else, and
    // quoting what it said is the only thing that gets an operator to the fix.
    return refuse(
      `This host answered Openship's probe with something other than the probe's output, ` +
        `so nothing about it could be measured. An sshd forced command (\`ForceCommand\`, or ` +
        `\`command=\` in authorized_keys) is the usual cause — AWS AMIs ship one on root's ` +
        `key and expect you to connect as ec2-user instead. It said: ` +
        `${JSON.stringify(facts.forcedCommand)}`,
    );
  }

  if (facts.os === "unknown") {
    // Same split as the arch refusal below, for the same reason: a host that answered
    // `FreeBSD` plainly is not a host we failed to measure, and telling its operator that
    // `uname -s` "returned nothing usable" sends them to debug a probe that worked. Only
    // one of these two sentences can be true of any given box.
    const observed = facts.osRaw?.trim();
    return refuse(
      observed
        ? `Openship drives Linux hosts (and macOS locally); this one reports \`uname -s\` as ` +
            `${JSON.stringify(observed)}, which it has no provisioning path for.`
        : "Could not determine this host's operating system (`uname -s` returned nothing usable).",
    );
  }

  // Before the distro check: an unknown arch is fatal regardless of how well we know
  // the distro, because every release artifact we fetch is arch-specific.
  if (facts.arch === "unknown") {
    // Naming the observed `uname -m` is the difference between an operator learning that
    // armv7l has no build and concluding that detection is broken on a box that answered
    // perfectly well.
    const observed = facts.archRaw?.trim();
    return refuse(
      observed
        ? `Openship has no build for this host's CPU architecture (\`uname -m\` reported ` +
            `${JSON.stringify(observed)}), and it will not guess — every release artifact it ` +
            `downloads is architecture-specific. x86_64/amd64 and aarch64/arm64 are supported.`
        : "Could not determine this host's CPU architecture (`uname -m` returned nothing " +
            "usable), and Openship will not guess — the release artifacts it downloads are " +
            "architecture-specific.",
    );
  }

  if (facts.os === "darwin") return SUPPORTED;

  switch (facts.distroFamily) {
    case "debian":
    case "rhel":
    case "alpine":
      break;
    case "suse":
      return refuse(
        `Openship doesn't drive openSUSE/SLES hosts${idSuffix(facts.distroId)} — it has no zypper ` +
          `provisioning path. Debian/Ubuntu, the RHEL family (including Amazon Linux) and Alpine are supported.`,
      );
    case "arch":
      return refuse(
        `Openship doesn't drive Arch hosts${idSuffix(facts.distroId)} — it has no pacman ` +
          `provisioning path. Debian/Ubuntu, the RHEL family (including Amazon Linux) and Alpine are supported.`,
      );
    case "unknown":
      // A family we cannot NAME is not a host we cannot DRIVE, and refusing here was the
      // origin bug with the sign flipped: `amzn` fell through to `unknown`, and the fix
      // must not turn that same fall-through into a hard admission failure for the next
      // unlisted RHEL/Debian rebuild. Packages, services and the firewall key off what was
      // actually probed, not off the family; the two things that do vary by family either
      // have a safe default (`sshd`) or refuse per method with their own reason
      // (`dockerInstall`). So the question that decides this host is the one below.
      if (facts.packageManager === "none") {
        return refuse(
          `Unrecognized Linux distribution${idSuffix(facts.distroId)} with no usable package ` +
            `manager. Openship could not match it to a supported family from its os-release ID ` +
            `or ID_LIKE, and found none of apt-get, dnf, yum or apk. Debian/Ubuntu, the RHEL ` +
            `family (including Amazon Linux) and Alpine are supported.`,
        );
      }
      return SUPPORTED;
    default: {
      // Both halves are load-bearing. The `never` assignment makes a new `DistroFamily`
      // member a compile error HERE, which is the one place that had none: adding a family
      // broke `dockerInstallSteps` and a prose string, neither of which touches the verdict,
      // so the host came out `{supported: true, unsupportedReason: null}` — the exact
      // invariant this module exists to hold. The runtime refusal matters too, because
      // `distroFamily` can be a value TypeScript says is impossible: an os-release `ID` that
      // names an `Object.prototype` key resolves through the classifier's plain-object
      // lookups and arrives here as neither a family nor `"unknown"`.
      const unwired: never = facts.distroFamily;
      return refuse(
        `Openship has no provisioning path for this host's Linux family ` +
          `(${JSON.stringify(String(unwired))})${idSuffix(facts.distroId)}. Debian/Ubuntu, the ` +
          `RHEL family (including Amazon Linux) and Alpine are supported.`,
      );
    }
  }

  if (facts.packageManager === "none") {
    return refuse(
      `No usable package manager found on this host (expected one of apt-get, dnf, yum or apk ` +
        `for a ${facts.distroFamily}-family system).`,
    );
  }

  return SUPPORTED;
}

function idSuffix(distroId: string | null): string {
  return distroId ? ` (os-release ID=${JSON.stringify(distroId)})` : "";
}
