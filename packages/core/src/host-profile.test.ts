import { describe, expect, it } from "vitest";

import {
  FAMILY_BY_DISTRO,
  assessHostSupport,
  classifyDistro,
  parseOsRelease,
  parseSystemArch,
  parseSystemOs,
  type HostSupportFacts,
} from "./host-profile";

/**
 * The pure classifiers, tested where they live.
 *
 * They were already exercised through the adapters' ~18-host fixture table, which proves
 * they work on the hosts we thought of. What that can't reach is the edges that exist ONLY
 * in these functions — a quoted os-release value, an `ID_LIKE` whose first token doesn't
 * map, a `uname -m` nobody has shipped. Those are exactly where the original bug lived:
 * `ID_LIKE` was read nowhere, and every unrecognized arch silently became amd64.
 *
 * Kept in core because that is where the functions are. A test one package away from its
 * subject is how `parseDistro` came to have no `amzn` arm while four tables asserted
 * confidently about hosts it had never classified.
 */

describe("parseOsRelease", () => {
  it("reads the plain form", () => {
    expect(parseOsRelease("ID=ubuntu\nVERSION_ID=24.04\n")).toEqual({
      ID: "ubuntu",
      VERSION_ID: "24.04",
    });
  });

  it("strips the quotes real distros ship", () => {
    // Debian double-quotes PRETTY_NAME, some RPM distros single-quote. A retained quote
    // makes `ID` fail every lookup while looking correct in a log line.
    const fields = parseOsRelease(`PRETTY_NAME="Debian GNU/Linux 12"\nID='debian'\n`);
    expect(fields.PRETTY_NAME).toBe("Debian GNU/Linux 12");
    expect(fields.ID).toBe("debian");
  });

  it("keeps an unbalanced quote rather than truncating the value", () => {
    expect(parseOsRelease(`PRETTY_NAME="12 inch\n`).PRETTY_NAME).toBe(`"12 inch`);
  });

  it("upper-cases keys and ignores comments and blanks", () => {
    expect(parseOsRelease("# a comment\n\nid=alpine\n")).toEqual({ ID: "alpine" });
  });

  it("keeps `=` inside a value", () => {
    expect(parseOsRelease('HOME_URL="https://x/?a=b"').HOME_URL).toBe("https://x/?a=b");
  });

  it("survives a file with no trailing newline and junk lines", () => {
    expect(parseOsRelease("NOEQUALS\n=leading\nID=rocky")).toEqual({ ID: "rocky" });
  });
});

describe("classifyDistro", () => {
  it("matches a known ID directly", () => {
    expect(classifyDistro("ubuntu")).toEqual({ distro: "ubuntu", family: "debian" });
  });

  it("normalizes case and surrounding space", () => {
    expect(classifyDistro("  Fedora  ").distro).toBe("fedora");
  });

  it("knows the IDs that look like nothing", () => {
    // `ol` is Oracle Linux. Nobody guesses this one, which is why it's in the table.
    expect(classifyDistro("ol")).toEqual({ distro: "oracle", family: "rhel" });
  });

  /** The origin bug, pinned: `amzn` used to hit no arm at all and cascade as `unknown`. */
  it("names Amazon Linux directly, ID_LIKE or not", () => {
    expect(classifyDistro("amzn", "fedora")).toEqual({ distro: "amzn", family: "rhel" });
    expect(classifyDistro("amzn")).toEqual({ distro: "amzn", family: "rhel" });
  });

  /**
   * The single line that would have prevented that bug without anyone naming `amzn`:
   * `ID_LIKE=fedora` had been sitting in its os-release the whole time, read nowhere.
   * It's what keeps the NEXT unlisted RHEL rebuild out of the unknown cascade.
   */
  it("falls back to ID_LIKE for an ID it doesn't name", () => {
    const it = classifyDistro("somerhelrebuild", "fedora");
    // Family known, distro still `unknown` — we can drive it, we just can't name it, and
    // claiming a specific distro from a family hint would be a guess.
    expect(it).toEqual({ distro: "unknown", family: "rhel" });
  });

  it("takes the FIRST ID_LIKE token that maps, not the first token", () => {
    // Amazon Linux 2 ships `ID_LIKE="centos rhel fedora"`; a hypothetical distro can lead
    // with a token we've never heard of. Bailing on the first unmapped token would put a
    // host we can classify perfectly well into the unknown cascade.
    expect(classifyDistro("weird", "nonesuch rhel").family).toBe("rhel");
  });

  it("reports unknown/unknown when neither ID nor ID_LIKE maps", () => {
    expect(classifyDistro("plan9", "inferno")).toEqual({ distro: "unknown", family: "unknown" });
  });

  it("treats a missing os-release as unknown rather than throwing", () => {
    expect(classifyDistro(null).family).toBe("unknown");
    expect(classifyDistro(undefined, undefined).family).toBe("unknown");
    expect(classifyDistro("", "").family).toBe("unknown");
  });

  it("never returns a family of `unknown` for a distro it named", () => {
    // The invariant `FAMILY_BY_DISTRO`'s `Exclude<…, "unknown">` key type enforces at
    // compile time, asserted at runtime so the two can't drift via a cast.
    for (const [distro, family] of Object.entries(FAMILY_BY_DISTRO)) {
      expect(family, distro).not.toBe("unknown");
      expect(classifyDistro(distro).family, distro).toBe(family);
    }
  });
});

describe("parseSystemArch", () => {
  it("maps both spellings of each arch we build for", () => {
    for (const m of ["x86_64", "amd64", "x64"]) expect(parseSystemArch(m)).toBe("amd64");
    for (const m of ["aarch64", "arm64", "armv8l"]) expect(parseSystemArch(m)).toBe("arm64");
  });

  /**
   * Never amd64 by default. A silent amd64 fallback is how an x86_64 Go tarball reached
   * hosts that cannot execute it — the download succeeds, the install succeeds, and the
   * binary fails at run time with `Exec format error`, nowhere near the cause.
   */
  it("refuses to guess an arch it doesn't recognize", () => {
    for (const m of ["armv7l", "riscv64", "ppc64le", "s390x", "", "   ", null, undefined]) {
      expect(parseSystemArch(m), String(m)).toBe("unknown");
    }
  });
});

describe("parseSystemOs", () => {
  it("recognizes the two it supports and nothing else", () => {
    expect(parseSystemOs("Linux")).toBe("linux");
    expect(parseSystemOs("darwin")).toBe("darwin");
    for (const os of ["FreeBSD", "MINGW64_NT", "", null]) expect(parseSystemOs(os)).toBe("unknown");
  });
});

describe("assessHostSupport", () => {
  const ok: HostSupportFacts = {
    os: "linux",
    osRaw: "Linux",
    arch: "amd64",
    archRaw: "x86_64",
    distroId: "ubuntu",
    distroFamily: "debian",
    packageManager: "apt",
    forcedCommand: null,
    probeError: null,
  };

  it("supports the families it has commands for", () => {
    for (const distroFamily of ["debian", "rhel", "alpine"] as const) {
      expect(assessHostSupport({ ...ok, distroFamily })).toEqual({
        supported: true,
        unsupportedReason: null,
      });
    }
  });

  it("supports macOS without asking about a distro", () => {
    const verdict = assessHostSupport({
      ...ok,
      os: "darwin",
      distroId: null,
      distroFamily: "unknown",
      packageManager: "brew",
    });
    expect(verdict.supported).toBe(true);
  });

  /**
   * Order is the load-bearing part. A forced-command AMI reports no uid, so it reads as
   * unprivileged and used to be told to "connect as root" — the exact opposite of the fix,
   * which the detector already knew. Each of these must beat the checks below it.
   */
  it("blames the probe before anything measured, because nothing below it is a fact", () => {
    const verdict = assessHostSupport({
      ...ok,
      os: "unknown",
      arch: "unknown",
      distroFamily: "unknown",
      packageManager: "none",
      forcedCommand: 'Please login as the user "ec2-user"',
      probeError: "channel closed after 30s",
    });
    expect(verdict.unsupportedReason).toContain("channel closed after 30s");
    // Not the forced command: that text is the HOST's output, this is OUR diagnostic, and
    // reading one as the other quotes our own probe back as if the box had said it.
    expect(verdict.unsupportedReason).not.toContain("ec2-user");
  });

  it("blames a forced command before an unknown arch or distro", () => {
    const verdict = assessHostSupport({
      ...ok,
      arch: "unknown",
      distroFamily: "unknown",
      forcedCommand: 'Please login as the user "ec2-user"',
    });
    expect(verdict.unsupportedReason).toContain("ec2-user");
    expect(verdict.unsupportedReason).toContain("ForceCommand");
  });

  it("blames an unknown arch before a distro it knows nothing about", () => {
    const verdict = assessHostSupport({
      ...ok,
      arch: "unknown",
      archRaw: "riscv64",
      distroFamily: "unknown",
    });
    expect(verdict.unsupportedReason).toContain("riscv64");
  });

  it("names the observed uname when it has one, and says so plainly when it doesn't", () => {
    expect(assessHostSupport({ ...ok, arch: "unknown", archRaw: "armv7l" }).unsupportedReason)
      .toContain("armv7l");
    expect(assessHostSupport({ ...ok, arch: "unknown", archRaw: null }).unsupportedReason)
      .toContain("architecture");
  });

  it("distinguishes an OS it won't drive from one it couldn't read", () => {
    // A BSD answers `uname -s` perfectly well; it is simply not a host Openship provisions.
    // Reporting that as "could not determine" sends its operator to debug our probe, which
    // is the same wrong turn the arch pair above exists to prevent.
    const bsd = assessHostSupport({ ...ok, os: "unknown", osRaw: "FreeBSD" });
    expect(bsd.supported).toBe(false);
    expect(bsd.unsupportedReason).toContain("FreeBSD");

    const silent = assessHostSupport({ ...ok, os: "unknown", osRaw: null });
    expect(silent.unsupportedReason).toContain("nothing usable");
    expect(silent.unsupportedReason).not.toContain("FreeBSD");
  });

  it("refuses suse and arch by name, with the package manager it lacks", () => {
    const suse = assessHostSupport({ ...ok, distroFamily: "suse", distroId: "opensuse-leap" });
    expect(suse.supported).toBe(false);
    expect(suse.unsupportedReason).toContain("zypper");
    expect(suse.unsupportedReason).toContain("opensuse-leap");

    const arch = assessHostSupport({ ...ok, distroFamily: "arch", distroId: "arch" });
    expect(arch.unsupportedReason).toContain("pacman");
  });

  it("quotes the ID back for a distro it could not place at all", () => {
    const verdict = assessHostSupport({
      ...ok,
      distroFamily: "unknown",
      distroId: "plan9",
      packageManager: "none",
    });
    expect(verdict.supported).toBe(false);
    expect(verdict.unsupportedReason).toContain("plan9");
    expect(verdict.unsupportedReason).toContain("ID_LIKE");
  });

  /**
   * The origin bug with the sign flipped. `amzn` fell through to `unknown` and got driven
   * badly; the fix must not turn that same fall-through into a refusal for the next unlisted
   * RHEL/Debian rebuild. A family we cannot NAME is not a host we cannot DRIVE — packages,
   * services and the firewall all key off what the probe actually found.
   */
  it("drives a distro it cannot place when the probe found a real package manager", () => {
    for (const packageManager of ["apt", "dnf", "yum", "apk"] as const) {
      const verdict = assessHostSupport({
        ...ok,
        distroFamily: "unknown",
        distroId: "somenewrebuild",
        packageManager,
      });
      expect(verdict, packageManager).toEqual({ supported: true, unsupportedReason: null });
    }
  });

  /**
   * The runtime half of the switch's `never` sink. `distroFamily` can hold a value the type
   * says is impossible: an os-release `ID` naming an `Object.prototype` key resolves through
   * the classifier's plain-object lookups and arrives as neither a family nor `"unknown"`.
   * Without the `default:` arm the function fell through to `return SUPPORTED` and declared
   * such a host fully provisionable.
   */
  it("refuses a family that is not in the union at all, rather than falling through", () => {
    for (const distroFamily of ["constructor", undefined] as unknown[]) {
      const verdict = assessHostSupport({ ...ok, distroFamily } as HostSupportFacts);
      expect(verdict.supported, String(distroFamily)).toBe(false);
      expect(verdict.unsupportedReason, String(distroFamily)).toContain("Amazon Linux");
    }
  });

  it("refuses a recognized family with no package manager", () => {
    const verdict = assessHostSupport({ ...ok, packageManager: "none" });
    expect(verdict.supported).toBe(false);
    expect(verdict.unsupportedReason).toContain("apt-get");
  });

  /**
   * Every refusal has to carry the fact it was based on. A generic "unsupported host" is
   * what this function exists to replace — it is the only thing standing between an
   * operator and a deploy that dies somewhere deep in provisioning instead.
   */
  it("never refuses without a reason, and never explains a host it supports", () => {
    const cases: HostSupportFacts[] = [
      ok,
      { ...ok, probeError: "timeout" },
      { ...ok, forcedCommand: "banner" },
      { ...ok, os: "unknown" },
      { ...ok, arch: "unknown" },
      { ...ok, distroFamily: "suse" },
      { ...ok, distroFamily: "arch" },
      { ...ok, distroFamily: "unknown" },
      { ...ok, packageManager: "none" },
    ];
    for (const facts of cases) {
      const { supported, unsupportedReason } = assessHostSupport(facts);
      if (supported) expect(unsupportedReason).toBeNull();
      else expect(unsupportedReason?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
