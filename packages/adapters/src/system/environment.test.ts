import { describe, it, expect, vi } from "vitest";
import {
  ENVIRONMENT_PROBE_SCRIPT,
  ENVIRONMENT_PROFILE_TTL_MS,
  invalidateEnvironment,
  parseEnvironmentProbe,
  resolveEnvironment,
} from "./environment";
import { elevatedExecutor } from "./elevated-executor";
import {
  interceptedProbe,
  OS_RELEASE,
  probeOutput,
  type ProbeSpec,
} from "./environment.fixtures";
import { SshDisconnectedError } from "./errors";
import type { CommandExecutor } from "../types";

/**
 * Detection is one round-trip now, so a fake is one answer: whatever the probe script
 * would have printed on the box being described. `probeOutput` renders that wire format.
 */
function hostFake(spec: ProbeSpec = {}): CommandExecutor {
  const exec = vi.fn(async () => probeOutput(spec));
  return { exec } as unknown as CommandExecutor;
}

/** A box that answers with something other than our script, and fails while doing it. */
function interceptedFake(message: string): CommandExecutor {
  const exec = vi.fn(async () => {
    throw new Error(message);
  });
  return { exec } as unknown as CommandExecutor;
}

describe("resolveEnvironment privilege detection", () => {
  it("reports isRoot when the probe says uid 0, and never probes sudo for root", async () => {
    const profile = await resolveEnvironment(hostFake({ uid: "0", sudo: "n" }));
    expect(profile.isRoot).toBe(true);
    expect(profile.canSudo).toBe(false);

    // The guard that used to be a skipped `exec` call now lives inside the script, so
    // this is where it has to be asserted — there is no second round-trip to not make.
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain('if [ "$(id -u 2>/dev/null)" != 0 ]; then');
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain("sudo -n true");
  });

  it("reports canSudo for a non-root user with passwordless sudo", async () => {
    const profile = await resolveEnvironment(
      hostFake({ uid: "1000", user: "deploy", sudo: "y" }),
    );
    expect(profile.isRoot).toBe(false);
    expect(profile.canSudo).toBe(true);
    expect(profile.loginUser).toBe("deploy");
  });

  it("reports neither for a non-root user without sudo", async () => {
    const profile = await resolveEnvironment(
      hostFake({ uid: "1000", user: "deploy", sudo: "n" }),
    );
    expect(profile.isRoot).toBe(false);
    expect(profile.canSudo).toBe(false);
  });

  it("still detects os / package manager alongside privilege", async () => {
    const profile = await resolveEnvironment(hostFake({ uid: "0" }));
    expect(profile.os).toBe("linux");
    expect(profile.packageManager).toBe("apt");
    expect(profile.serviceManager).toBe("systemd");
    expect(profile.distro).toBe("ubuntu");
  });
});

describe("resolveEnvironment cost", () => {
  /**
   * The regression guard for the reason the detector was rewritten: it used to cost up
   * to eleven sequential SSH round-trips (the package-manager probe alone was a
   * five-step ladder), which at the old 5s timeout was a 55s worst case.
   */
  it("establishes every fact in exactly one round-trip", async () => {
    const executor = hostFake();
    await resolveEnvironment(executor);
    expect(vi.mocked(executor.exec)).toHaveBeenCalledTimes(1);
  });

  it("caches per host, not per view of one", async () => {
    const inner = hostFake();
    const elevated = elevatedExecutor(inner);

    const first = await resolveEnvironment(inner);
    const second = await resolveEnvironment(elevated);

    // An elevated view is a Proxy, so a naive cache would re-probe — and could then
    // disagree with the unelevated view about canSudo for the same box.
    expect(second).toBe(first);
    expect(vi.mocked(inner.exec)).toHaveBeenCalledTimes(1);
  });

  it("re-probes after invalidateEnvironment", async () => {
    const executor = hostFake();
    await resolveEnvironment(executor);
    invalidateEnvironment(executor);
    await resolveEnvironment(executor);
    expect(vi.mocked(executor.exec)).toHaveBeenCalledTimes(2);
  });

  it("does not cache a transport failure", async () => {
    let attempt = 0;
    const executor = {
      exec: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new SshDisconnectedError();
        return probeOutput();
      }),
    } as unknown as CommandExecutor;

    // A blip used to be permanent for the executor's lifetime: the rejected promise
    // stayed in the cache and every later caller re-awaited the same failure.
    await expect(resolveEnvironment(executor)).rejects.toThrow(SshDisconnectedError);
    await expect(resolveEnvironment(executor)).resolves.toMatchObject({ os: "linux" });
  });
});

describe("resolveEnvironment distro classification", () => {
  it("resolves Amazon Linux 2023 to the rhel family via ID_LIKE", async () => {
    const profile = await resolveEnvironment(
      hostFake({ osRelease: OS_RELEASE.amzn2023, pm: "dnf" }),
    );
    // The origin bug: ID=amzn matches no allowlist, so this used to be `distro:
    // "unknown"` and every distro-gated provisioning step was silently skipped.
    expect(profile.distroId).toBe("amzn");
    expect(profile.distroFamily).toBe("rhel");
    expect(profile.versionId).toBe("2023");
    expect(profile.supported).toBe(true);
    expect(profile.unsupportedReason).toBeNull();
  });

  it("resolves Amazon Linux 2 from a multi-token ID_LIKE", async () => {
    const profile = await resolveEnvironment(
      hostFake({ osRelease: OS_RELEASE.amzn2, pm: "yum" }),
    );
    expect(profile.distroFamily).toBe("rhel");
    expect(profile.versionId).toBe("2");
    expect(profile.packageManager).toBe("yum");
    expect(profile.supported).toBe(true);
  });

  it("resolves Oracle Linux's ID=ol by name", async () => {
    const profile = await resolveEnvironment(
      hostFake({ osRelease: OS_RELEASE.oracle9, pm: "dnf" }),
    );
    expect(profile.distro).toBe("oracle");
    expect(profile.distroFamily).toBe("rhel");
  });

  it("resolves Mint to the debian family via ID_LIKE", async () => {
    const profile = await resolveEnvironment(hostFake({ osRelease: OS_RELEASE.mint213 }));
    expect(profile.distro).toBe("unknown");
    expect(profile.distroFamily).toBe("debian");
    expect(profile.supported).toBe(true);
  });

  it("reads Alpine as apk / openrc / musl", async () => {
    const profile = await resolveEnvironment(
      hostFake({ osRelease: OS_RELEASE.alpine320, pm: "apk", sm: "openrc", libc: "musl" }),
    );
    expect(profile.distroFamily).toBe("alpine");
    expect(profile.libc).toBe("musl");
    expect(profile.serviceManager).toBe("openrc");
    expect(profile.supported).toBe(true);
  });
});

describe("resolveEnvironment refusals", () => {
  it("refuses openSUSE by name, naming zypper", async () => {
    const profile = await resolveEnvironment(
      hostFake({ osRelease: OS_RELEASE.opensuse156, pm: "none" }),
    );
    expect(profile.distro).toBe("opensuse");
    expect(profile.distroFamily).toBe("suse");
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("zypper");
  });

  it("refuses an unrecognized distro it also cannot install on, quoting the observed ID", async () => {
    const profile = await resolveEnvironment(
      hostFake({ osRelease: OS_RELEASE.mystery, pm: "none" }),
    );
    expect(profile.distroFamily).toBe("unknown");
    expect(profile.supported).toBe(false);
    // A generic "unsupported host" is useless to an operator; the ID is the lead.
    expect(profile.unsupportedReason).toContain("frobnicate");
  });

  it("drives an unrecognized distro whose package manager answered", async () => {
    // Not a refusal, deliberately: an unplaceable ID with working apt is the shape the
    // origin bug had (`amzn` fell through to `unknown`), and turning that fall-through
    // into a hard admission failure would fail the next unlisted rebuild the same way.
    // What actually varies by family refuses per method — see `dockerInstall`.
    const profile = await resolveEnvironment(hostFake({ osRelease: OS_RELEASE.mystery }));
    expect(profile.distroFamily).toBe("unknown");
    expect(profile.packageManager).toBe("apt");
    expect(profile).toMatchObject({ supported: true, unsupportedReason: null });
  });

  it("refuses an unknown architecture rather than assuming amd64", async () => {
    const profile = await resolveEnvironment(hostFake({ arch: "riscv64" }));
    expect(profile.arch).toBe("unknown");
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("architecture");
  });

  it("refuses a host with no package manager", async () => {
    const profile = await resolveEnvironment(hostFake({ pm: "none" }));
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("package manager");
  });

  it("refuses a host whose sshd runs a forced command, quoting what it said", async () => {
    // The AWS AMI ships this on root's key and exits 142, so every command Openship
    // sends runs it instead — the box looks reachable and answers nothing, which is the
    // shape the Amazon Linux `socket hang up` arrived in.
    const profile = await resolveEnvironment(
      interceptedFake('Please login as the user "ec2-user" rather than the user "root".'),
    );
    expect(profile.forcedCommand).toContain("ec2-user");
    expect(profile.os).toBe("unknown");
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("ec2-user");
  });

  it("treats any unbracketed answer as interception, not just the AWS wording", async () => {
    // Risk: matching the one forced command we have seen would read every other one as
    // an empty box. The signal is structural — our own markers are missing.
    const profile = await resolveEnvironment(interceptedFake("this account is restricted"));
    expect(profile.forcedCommand).toBe("this account is restricted");
    expect(profile.supported).toBe(false);
  });
});

describe("a probe that never came back", () => {
  /**
   * A timeout is not a forced command, and the difference is the whole point of the split.
   *
   * Both arrive as "the probe threw and printed none of my keys", so both used to land in
   * `forcedCommand` — which told an operator on a merely-loaded box that their sshd
   * intercepts every command. One is a fact about the host's config, the other is our own
   * diagnostic, and only the first is worth acting on.
   */
  it("reads a timeout as unmeasured, not as an sshd forced command", async () => {
    const profile = await resolveEnvironment(
      interceptedFake("command timed out after 20000ms: sh -lc 'set -e …'"),
    );

    expect(profile.forcedCommand).toBeNull();
    expect(profile.probeError).toContain("timed out");
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("could not measure");
    // Specifically NOT the forced-command reason: that one sends the operator to
    // authorized_keys on a box whose only problem was that it was busy.
    expect(profile.unsupportedReason).not.toMatch(/forced command|ForceCommand/i);
  });

  it("does not cache a non-measurement, so the next caller re-probes", async () => {
    let attempt = 0;
    const executor = {
      exec: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("channel closed without an exit status");
        return probeOutput();
      }),
    } as unknown as CommandExecutor;

    // Unlike a forced command (a stable fact about the host, worth caching), a timeout is
    // a moment. Caching it pinned an unsupported verdict on a supported box for the whole
    // lifetime of the executor — and every gate downstream reads that verdict.
    await expect(resolveEnvironment(executor)).resolves.toMatchObject({ supported: false });
    await expect(resolveEnvironment(executor)).resolves.toMatchObject({
      supported: true,
      probeError: null,
    });
  });

  it("still caches a forced command, which is a fact about the host", async () => {
    const executor = interceptedFake('Please login as the user "ec2-user".');

    await resolveEnvironment(executor);
    await resolveEnvironment(executor);

    expect(vi.mocked(executor.exec)).toHaveBeenCalledTimes(1);
  });

  /**
   * ssh2 reports no exit code when the process is killed by a signal, so the executors'
   * `detail || \`Exit code ${code}\`` fallback comes back as `"Exit code null"` — a string
   * that is ours, on a box that printed nothing. Read as the host's answer it accused the
   * operator's sshd of a forced command and quoted our own error text as the evidence.
   */
  it("reads a signal-killed probe as unmeasured, not as the host's answer", async () => {
    const profile = await resolveEnvironment(interceptedFake("Exit code null"));

    expect(profile.forcedCommand).toBeNull();
    expect(profile.probeError).toBe("Exit code null");
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("could not measure");
    expect(profile.unsupportedReason).not.toMatch(/forced command|ForceCommand/i);
  });

  it("reads a bare exit status with no output the same way, whatever the code", async () => {
    for (const text of ["Exit code 143", "Exit code undefined"]) {
      const profile = await resolveEnvironment(interceptedFake(text));
      expect(profile.forcedCommand).toBeNull();
      expect(profile.probeError).toBe(text);
    }
  });

  /**
   * The structural half, at the parser: no host text to quote means nothing answered,
   * whatever the executor thought. The local path builds probes by hand and reaches here
   * with `unanswered: false` after a spawn that was killed with an empty stderr.
   */
  it("reads a failure with no text at all as unmeasured", () => {
    const profile = parseEnvironmentProbe(interceptedProbe(""));

    expect(profile.forcedCommand).toBeNull();
    expect(profile.probeError).toBeTruthy();
    expect(profile.unsupportedReason).toContain("could not measure");
  });

  it("re-probes after a signal kill instead of pinning the verdict", async () => {
    let attempt = 0;
    const executor = {
      exec: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Exit code null");
        return probeOutput();
      }),
    } as unknown as CommandExecutor;

    await expect(resolveEnvironment(executor)).resolves.toMatchObject({ supported: false });
    await expect(resolveEnvironment(executor)).resolves.toMatchObject({
      supported: true,
      probeError: null,
    });
  });

  /** A shell that answered with nothing said nothing — there is no banner to blame. */
  it("reads an empty answer as unmeasured, not as an undetectable OS", async () => {
    const profile = await resolveEnvironment({
      exec: vi.fn(async () => "   \n"),
    } as unknown as CommandExecutor);

    expect(profile.forcedCommand).toBeNull();
    expect(profile.probeError).toBeTruthy();
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("could not measure");
    expect(profile.unsupportedReason).not.toMatch(/operating system/i);
  });
});

describe("the probe script", () => {
  it("requires both a systemd PID 1 and a systemctl binary", () => {
    // Containers ship systemctl with no running systemd; minimal installs run systemd
    // with no systemctl. Either alone used to read as "systemd" here, while
    // runtime/supervisor/detect.ts already tested both — three tests, two answers.
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain(
      "[ -d /run/systemd/system ] && command -v systemctl",
    );
  });

  it("always exits 0, so a non-zero exit means something else answered", () => {
    expect(ENVIRONMENT_PROBE_SCRIPT.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("brackets its output so interception is detectable without pattern-matching", () => {
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain('echo "opsh_begin=1"');
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain('echo "opsh_end=1"');
  });

  it("puts the sbin directories on PATH, where the firewall tools live", () => {
    // `ufw`, `nft` and `iptables` are in /usr/sbin, which is off a non-root user's PATH on
    // Debian — so `command -v ufw` failed and "no firewall installed" was really "not on
    // this user's PATH". Appended, never replaced: the host's own PATH comes first.
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain('PATH="$PATH:/usr/sbin:/sbin"');
  });

  it("reads the rulesets with sudo when it has it, since those reads are privileged", () => {
    // `iptables -S` and `firewall-cmd --state` refuse outright for an unprivileged user,
    // and a refused read came back as "no firewall" — the one answer that makes the
    // caller skip opening a port.
    for (const read of ["ufw status", "firewall-cmd --state", "nft list tables", "iptables -S INPUT"]) {
      expect(ENVIRONMENT_PROBE_SCRIPT).toContain(`$PRIV ${read}`);
    }
    // Established before the first of them, or the prefix is empty where it is needed.
    expect(ENVIRONMENT_PROBE_SCRIPT.indexOf('PRIV="sudo -n"')).toBeLessThan(
      ENVIRONMENT_PROBE_SCRIPT.indexOf("$PRIV ufw status"),
    );
  });

  it("judges iptables on its rules, not only on its policy", () => {
    // RHEL's stock ruleset ends INPUT in a catch-all REJECT with the policy left at
    // ACCEPT. Reading `-P INPUT` alone called those hosts unfirewalled, so nothing opened
    // a port and the service came up unreachable.
    expect(ENVIRONMENT_PROBE_SCRIPT).toMatch(/-A INPUT .*-j \(DROP\|REJECT\)/);
    // netfilter has no REJECT policy, so an arm matching one can never be taken.
    expect(ENVIRONMENT_PROBE_SCRIPT).not.toContain('*"-P INPUT REJECT"*');
  });

  it("stays POSIX sh — Alpine is busybox ash", () => {
    // `[[:space:]]` is a POSIX character class and stays; bash's `[[` does not.
    expect(ENVIRONMENT_PROBE_SCRIPT).not.toMatch(/\[\[(?!:)/);
    expect(ENVIRONMENT_PROBE_SCRIPT).not.toMatch(/\$\{/);
    expect(ENVIRONMENT_PROBE_SCRIPT).not.toMatch(/\blocal\b/);
  });
});

/**
 * How long a measurement lasts, and how many measurements there are at once.
 *
 * These are one subject because they were one bug: the profile's lifetime and its scope
 * were both accidents of the cache key. A WeakMap on the executor object meant a host was
 * measured once and believed until that object was collected — days, for a pooled server
 * connection — and it meant "which host" was answered by object identity, which is right
 * for two servers and wrong for two views of one server.
 */
describe("profile lifetime", () => {
  /** Run `fn` with `Date.now()` under our control, and nothing else faked — faking the
   *  timers too would deadlock on the awaits below. */
  async function atTime(fn: (advance: (ms: number) => void) => Promise<void>) {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await fn((ms) => vi.setSystemTime(Date.now() + ms));
    } finally {
      vi.useRealTimers();
    }
  }

  it("re-measures once the window has passed", async () => {
    await atTime(async (advance) => {
      const executor = hostFake();

      await resolveEnvironment(executor);
      advance(ENVIRONMENT_PROFILE_TTL_MS - 1_000);
      await resolveEnvironment(executor);
      // Still inside the window: the point of a window is that most calls are free.
      expect(vi.mocked(executor.exec)).toHaveBeenCalledTimes(1);

      advance(2_000);
      await resolveEnvironment(executor);
      expect(vi.mocked(executor.exec)).toHaveBeenCalledTimes(2);
    });
  });

  it("sees a change the operator made out of band", async () => {
    await atTime(async (advance) => {
      let sudo: "y" | "n" = "n";
      const executor = {
        exec: vi.fn(async () => probeOutput({ uid: "1000", user: "deploy", sudo })),
      } as unknown as CommandExecutor;

      expect((await resolveEnvironment(executor)).canSudo).toBe(false);

      // The whole reason for a lifetime: this is what an operator does *because* Openship
      // told them their login needs root, and then they retry. With no expiry the retry
      // reads the same refusal until the API restarts.
      sudo = "y";
      advance(ENVIRONMENT_PROFILE_TTL_MS + 1);
      expect((await resolveEnvironment(executor)).canSudo).toBe(true);
    });
  });

  it("keeps the last good measurement when a re-measure never comes back", async () => {
    await atTime(async (advance) => {
      let attempt = 0;
      const executor = {
        exec: vi.fn(async () => {
          attempt += 1;
          if (attempt === 1) return probeOutput({ osRelease: OS_RELEASE.amzn2023, pm: "dnf" });
          throw new Error("Command timed out after 20000ms");
        }),
      } as unknown as CommandExecutor;

      const first = await resolveEnvironment(executor);
      expect(first.supported).toBe(true);

      advance(ENVIRONMENT_PROFILE_TTL_MS + 1);
      const second = await resolveEnvironment(executor);

      // Expiry may let a good answer improve; it may not let a non-answer arrive. A
      // `probeError` renders as `supported: false`, so without this one slow moment turns
      // an hour of successful deploys into "Openship cannot provision this machine".
      expect(second.supported).toBe(true);
      expect(second.distroFamily).toBe("rhel");
      expect(second.probeError).toBeNull();

      // And it does not retry on every call afterwards — the attempt is rate-limited by
      // the same window, or a wedged box would be probed once per resolve.
      await resolveEnvironment(executor);
      expect(vi.mocked(executor.exec)).toHaveBeenCalledTimes(2);
    });
  });

  it("believes a forced command that appeared since, unlike a timeout", async () => {
    await atTime(async (advance) => {
      let attempt = 0;
      const executor = {
        exec: vi.fn(async () => {
          attempt += 1;
          if (attempt === 1) return probeOutput();
          // Not our output, but it IS the host's — the operator added a ForceCommand.
          // A real change, so unlike a timeout it must not be papered over.
          throw new Error('Please login as the user "ec2-user" rather than the user "root".');
        }),
      } as unknown as CommandExecutor;

      expect((await resolveEnvironment(executor)).supported).toBe(true);
      advance(ENVIRONMENT_PROFILE_TTL_MS + 1);

      const second = await resolveEnvironment(executor);
      expect(second.supported).toBe(false);
      expect(second.unsupportedReason).toContain("ec2-user");
    });
  });
});

/**
 * Two hosts at once — the case a fleet is made of, and the one no test covered.
 *
 * Every other test here drives a single box, so a cache that answered "the last host I
 * measured" instead of "this host" would pass all of them. That is not hypothetical: the
 * proxy-unwrapping cache key is exactly the code that decides whether two executors mean
 * two boxes or one, and it is asked that question on every multi-server deploy.
 */
describe("two hosts at once", () => {
  it("keeps a profile per host, and never leaks one host's answer into the other", async () => {
    const debian = hostFake({ osRelease: OS_RELEASE.debian12 });
    const alpine = hostFake({
      osRelease: OS_RELEASE.alpine320,
      pm: "apk",
      sm: "openrc",
      libc: "musl",
      uid: "1000",
      user: "deploy",
      home: "/home/deploy",
      sudo: "y",
    });

    // Interleaved rather than sequential: a deploy fans out across servers, so the
    // second host's probe can land between the first's and its next read.
    const [a, b] = await Promise.all([resolveEnvironment(debian), resolveEnvironment(alpine)]);

    expect(a.packageManager).toBe("apt");
    expect(a.isRoot).toBe(true);
    expect(b.packageManager).toBe("apk");
    expect(b.serviceManager).toBe("openrc");
    expect(b.isRoot).toBe(false);
    expect(b.home).toBe("/home/deploy");

    expect(await resolveEnvironment(debian)).toBe(a);
    expect(await resolveEnvironment(alpine)).toBe(b);
    expect(vi.mocked(debian.exec)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alpine.exec)).toHaveBeenCalledTimes(1);
  });

  it("shares an elevated view with its own host, not with whichever was measured last", async () => {
    const debian = hostFake({ osRelease: OS_RELEASE.debian12 });
    const alpine = hostFake({ osRelease: OS_RELEASE.alpine320, pm: "apk", sm: "openrc" });

    const a = await resolveEnvironment(debian);
    await resolveEnvironment(alpine);

    // The proxy unwraps to `debian`, so this must hit debian's entry — not alpine's,
    // which is the most recent, and not a fresh probe.
    expect(await resolveEnvironment(elevatedExecutor(debian))).toBe(a);
    expect(vi.mocked(debian.exec)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alpine.exec)).toHaveBeenCalledTimes(1);
  });

  it("invalidates one host without disturbing the other", async () => {
    const debian = hostFake({ osRelease: OS_RELEASE.debian12 });
    const alpine = hostFake({ osRelease: OS_RELEASE.alpine320, pm: "apk", sm: "openrc" });

    await resolveEnvironment(debian);
    const b = await resolveEnvironment(alpine);

    // `sshManager.invalidate(serverId)` is per-server. Dropping the fleet's profiles
    // because one row changed would re-probe every box in it.
    invalidateEnvironment(debian);
    await resolveEnvironment(debian);
    expect(await resolveEnvironment(alpine)).toBe(b);

    expect(vi.mocked(debian.exec)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alpine.exec)).toHaveBeenCalledTimes(1);
  });

  it("measures the host, not the view — an elevated executor does not make the box root", async () => {
    // The box a real `sudo -n` changes the answer of: uid 1000 as the login user, uid 0
    // under sudo. `hostFake` ignores its command, so it cannot show this.
    // `startsWith`, not `includes`: the probe script has its own `sudo -n true` inside it,
    // so only the wrapper's leading `sudo -n sh -c` distinguishes the elevated view.
    const exec = vi.fn(async (command: string) =>
      command.startsWith("sudo -n")
        ? probeOutput({ uid: "0", user: "root", home: "/root", sudo: "n" })
        : probeOutput({ uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" }),
    );
    const box = { exec } as unknown as CommandExecutor;

    // COLD cache reached through the elevated view first — the only ordering where this
    // is observable, and the one `cacheKeyFor`'s unwrap made reachable for the whole host
    // rather than just for the view.
    const profile = await resolveEnvironment(elevatedExecutor(box));

    expect(profile.isRoot).toBe(false);
    expect(profile.loginUser).toBe("deploy");
    expect(profile.home).toBe("/home/deploy");
    // The one that matters downstream: `privilegedExecutor` short-circuits on `isRoot` and
    // hands back the UNELEVATED executor, so a true-here profile runs root-owned work
    // unprivileged — the #514 non-root failure re-entered through the cache.
    expect(profile.canSudo).toBe(true);

    // Cache key and measured subject are the same thing, so the base view is already
    // answered — with the profile of the box, not of the view that happened to ask.
    expect(await resolveEnvironment(box)).toBe(profile);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]?.startsWith("sudo -n")).toBe(false);
  });

  it("invalidates through an elevated view, reaching the host underneath", async () => {
    const debian = hostFake({ osRelease: OS_RELEASE.debian12 });
    const alpine = hostFake({ osRelease: OS_RELEASE.alpine320, pm: "apk", sm: "openrc" });

    await resolveEnvironment(debian);
    const b = await resolveEnvironment(alpine);

    invalidateEnvironment(elevatedExecutor(debian));
    await resolveEnvironment(debian);
    expect(await resolveEnvironment(alpine)).toBe(b);
    expect(vi.mocked(debian.exec)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alpine.exec)).toHaveBeenCalledTimes(1);
  });
});
