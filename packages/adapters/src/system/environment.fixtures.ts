/**
 * The hosts under test, in one place.
 *
 * Test-only (nothing under `src/index.ts` reaches it, so it stays out of the bundle),
 * but not test-*local*: the detector tests, the `environment-ops` totality properties,
 * and the per-distro e2e all have to agree about what "Amazon Linux 2023" is, or the
 * bug they exist to catch can hide in the gap between three hand-written literals.
 *
 * Two kinds of fixture, for two layers:
 *
 * - `OS_RELEASE` — **verbatim `/etc/os-release` text** from real releases, so the parser
 *   meets the strings it will actually meet (quoted and unquoted values on the same box,
 *   `ID=ol`, `ID_LIKE="centos rhel fedora"`). Hand-normalized key/value pairs would test
 *   the fixture author's idea of os-release rather than os-release.
 * - `profileFixture()` — a resolved profile for consumers of one, which recomputes the
 *   support verdict from the facts so a fixture cannot claim to be a supported openSUSE.
 */

import { assessHostSupport, type EnvironmentProfile } from "@repo/core";

import type { EnvironmentProbe } from "./environment";

// ─── Verbatim /etc/os-release ────────────────────────────────────────────────

/** Real release text. Keep the original quoting and key order — that is the point. */
export const OS_RELEASE = {
  ubuntu2404: `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
UBUNTU_CODENAME=noble`,

  debian12: `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"`,

  // The origin bug. `ID=amzn` matches no allowlist in the codebase; `ID_LIKE="fedora"`
  // has been sitting here the whole time, unread.
  amzn2023: `NAME="Amazon Linux"
VERSION="2023"
ID="amzn"
ID_LIKE="fedora"
VERSION_ID="2023"
PLATFORM_ID="platform:al2023"
PRETTY_NAME="Amazon Linux 2023.6.20241111"
ANSI_COLOR="0;33"
CPE_NAME="cpe:2.3:o:amazon:amazon_linux:2023"
HOME_URL="https://aws.amazon.com/linux/amazon-linux-2023/"`,

  // Multi-token ID_LIKE, most-specific first — proves first-match is the right read.
  amzn2: `NAME="Amazon Linux"
VERSION="2"
ID="amzn"
ID_LIKE="centos rhel fedora"
VERSION_ID="2"
PRETTY_NAME="Amazon Linux 2"
ANSI_COLOR="0;33"
CPE_NAME="cpe:2.3:o:amazon:amazon_linux:2"
HOME_URL="https://amazonlinux.com/"`,

  rocky9: `NAME="Rocky Linux"
VERSION="9.4 (Blue Onyx)"
ID="rocky"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"
CPE_NAME="cpe:/o:rocky:rocky:9::baseos"`,

  // A distinct ID that must resolve on its own, not via ID_LIKE — proves the ID map is
  // doing work and the family isn't only ever inferred.
  alma9: `NAME="AlmaLinux"
VERSION="9.4 (Seafoam Ocelot)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="AlmaLinux 9.4 (Seafoam Ocelot)"`,

  /** `ID=ol` — the ID that looks like nothing. */
  oracle9: `NAME="Oracle Linux Server"
VERSION="9.4"
ID="ol"
ID_LIKE="fedora"
VARIANT="Server"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="Oracle Linux Server 9.4"`,

  rhel9: `NAME="Red Hat Enterprise Linux"
VERSION="9.4 (Plow)"
ID="rhel"
ID_LIKE="fedora"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"`,

  /** Unquoted VERSION_ID, next to quoted values — the parser meets both. */
  fedora40: `NAME="Fedora Linux"
VERSION="40 (Server Edition)"
ID=fedora
VERSION_ID=40
PLATFORM_ID="platform:f40"
PRETTY_NAME="Fedora Linux 40 (Server Edition)"`,

  centos7: `NAME="CentOS Linux"
VERSION="7 (Core)"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="7"
PRETTY_NAME="CentOS Linux 7 (Core)"`,

  alpine320: `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.20.3
PRETTY_NAME="Alpine Linux v3.20"
HOME_URL="https://alpinelinux.org/"`,

  /** Recognized and refused. No zypper path is wired, and none should appear. */
  opensuse156: `NAME="openSUSE Leap"
VERSION="15.6"
ID="opensuse-leap"
ID_LIKE="suse opensuse"
VERSION_ID="15.6"
PRETTY_NAME="openSUSE Leap 15.6"`,

  /** Recognized and refused. No VERSION_ID at all — rolling release. */
  arch: `NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling
HOME_URL="https://archlinux.org/"`,

  /** Unknown ID, debian family via ID_LIKE — the same mechanism as Amazon Linux, other side. */
  mint213: `NAME="Linux Mint"
VERSION="21.3 (Virginia)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 21.3"
VERSION_ID="21.3"`,

  popos2204: `NAME="Pop!_OS"
VERSION="22.04 LTS"
ID=pop
ID_LIKE="ubuntu debian"
VERSION_ID="22.04"
PRETTY_NAME="Pop!_OS 22.04 LTS"`,

  /** No ID_LIKE and an ID nobody knows — must refuse, quoting the ID back. */
  mystery: `NAME="Frobnicate OS"
ID=frobnicate
VERSION_ID="1"
PRETTY_NAME="Frobnicate OS 1"`,
} as const;

// ─── Rendering what the probe script would print ─────────────────────────────

/**
 * One host as the probe script would report it.
 *
 * Every field is what the *script* emits, not what the profile ends up with, so a test
 * describes a box rather than an answer. Defaults are a plain root Ubuntu box.
 */
export interface ProbeSpec {
  /** `uname -s`. */
  os?: string;
  /** `uname -m` — the kernel's spelling (`x86_64`), not the artifact's (`amd64`). */
  arch?: string;
  uid?: string;
  user?: string;
  home?: string;
  /** Verbatim os-release text, or `null` for a host without one. */
  osRelease?: string | null;
  pm?: string;
  sm?: string;
  fw?: string;
  libc?: string;
  selinux?: string;
  container?: "y" | "n";
  sudo?: "y" | "n";
}

/**
 * Render probe output for a spec.
 *
 * This mirrors the script's wire format rather than re-deriving any fact from any other,
 * so it can't quietly encode a second detector. That the real script produces this shape
 * on a real distro is the per-distro e2e's job, not this helper's.
 */
export function probeOutput(spec: ProbeSpec = {}): string {
  const {
    os = "Linux",
    arch = "x86_64",
    uid = "0",
    user = "root",
    home = "/root",
    osRelease = OS_RELEASE.ubuntu2404,
    pm = "apt",
    sm = "systemd",
    fw = "none",
    libc = "glibc",
    selinux = "absent",
    container = "n",
    sudo = "n",
  } = spec;

  const lines = [
    "opsh_begin=1",
    `opsh_os=${os}`,
    `opsh_arch=${arch}`,
    `opsh_uid=${uid}`,
    `opsh_user=${user}`,
    `opsh_home=${home}`,
    ...(osRelease === null
      ? []
      : osRelease.split("\n").map((line) => `opsh_osr:${line}`)),
    `opsh_pm=${pm}`,
    `opsh_sm=${sm}`,
    `opsh_fw=${fw}`,
    `opsh_libc=${libc}`,
    `opsh_selinux=${selinux}`,
    `opsh_container=${container}`,
    `opsh_sudo=${sudo}`,
    "opsh_end=1",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The three ways a probe can come back, named — because the difference between the last
 * two is the whole reason `unanswered` exists, and a test that spells the flags inline
 * gets to pick a combination the runtime never produces.
 */

/** It ran and printed our keys. */
export function answeredProbe(spec: ProbeSpec = {}): EnvironmentProbe {
  return { text: probeOutput(spec), failed: false, unanswered: false };
}

/**
 * Something answered, but not us — an sshd `ForceCommand` printed its own text.
 * `failed` because the AWS AMI's forced command exits 142; `unanswered: false` because
 * the text IS the host's answer, and that is what tells this apart from a timeout.
 */
export function interceptedProbe(text: string): EnvironmentProbe {
  return { text, failed: true, unanswered: false };
}

/** Nothing answered: a timeout, or a channel torn down mid-command. */
export function unansweredProbe(text: string): EnvironmentProbe {
  return { text, failed: true, unanswered: true };
}

// ─── A resolved profile, for consumers of one ────────────────────────────────

/** A plain root Ubuntu box: supported, no firewall, systemd, amd64. */
const BASE: EnvironmentProfile = {
  os: "linux",
  osRaw: "Linux",
  arch: "amd64",
  archRaw: "x86_64",
  distro: "ubuntu",
  distroFamily: "debian",
  distroId: "ubuntu",
  versionId: "24.04",
  prettyName: "Ubuntu 24.04.1 LTS",
  packageManager: "apt",
  serviceManager: "systemd",
  firewall: "none",
  libc: "glibc",
  selinux: "absent",
  isContainer: false,
  isRoot: true,
  canSudo: false,
  loginUser: "root",
  home: "/root",
  forcedCommand: null,
  probeError: null,
  supported: true,
  unsupportedReason: null,
};

/**
 * A profile for a test that needs one, with the verdict recomputed from the facts.
 *
 * Recomputing rather than defaulting is what stops a fixture from lying: override
 * `distroFamily: "suse"` and the fixture becomes unsupported with openSUSE's real
 * reason, because that is what the detector would have produced. A test can still pin
 * `supported` explicitly when the disagreement is the thing under test.
 */
export function profileFixture(over: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  const merged: EnvironmentProfile = { ...BASE, ...over };
  // `arch`/`archRaw` and `os`/`osRaw` are each ONE observation, and both refusals quote the
  // raw half — so overriding only the narrowed half would produce a fixture that refuses a
  // riscv box by the name `x86_64`, or a FreeBSD one by the name `Linux`. Inherit the base's
  // raw value only while the narrowed value is still the base's.
  const archRaw = "archRaw" in over || merged.arch === BASE.arch ? merged.archRaw : null;
  const osRaw = "osRaw" in over || merged.os === BASE.os ? merged.osRaw : null;
  const verdict = assessHostSupport({ ...merged, archRaw, osRaw });
  return {
    ...merged,
    archRaw,
    osRaw,
    supported: over.supported ?? verdict.supported,
    unsupportedReason:
      "unsupportedReason" in over ? (over.unsupportedReason ?? null) : verdict.unsupportedReason,
  };
}
