import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../types";
import type { EnvironmentProfile } from "./environment";
import { profileFixture } from "./environment.fixtures";
import type { ComponentStatus } from "./types";
import { normalizePkgVersion, enrichAvailableVersions } from "./available-version";

describe("normalizePkgVersion", () => {
  it("strips apt epoch + debian/rpm revision to upstream semver", () => {
    expect(normalizePkgVersion("1:2.43.0-1ubuntu7")).toBe("2.43.0");
    expect(normalizePkgVersion("3.2.7-1")).toBe("3.2.7");
    expect(normalizePkgVersion("2.9.0")).toBe("2.9.0");
    expect(normalizePkgVersion("1.31.1.1")).toBe("1.31.1.1"); // 4-part kept
  });
});

const APT: EnvironmentProfile = profileFixture();

function fakeExecutor(candidates: Record<string, string>): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      // `apt-cache policy <pkg> …` — the name is bare because `envOps` VALIDATES
      // package names against a strict pattern rather than quoting them, so there
      // are no quotes here to key on.
      const m = cmd.match(/apt-cache policy (\S+)/);
      if (m) {
        const cand = candidates[m[1]!];
        if (cand === undefined) throw new Error("no such package");
        return `Installed: (whatever)\n  Candidate: ${cand}\n`;
      }
      throw new Error("unexpected command");
    },
  } as unknown as CommandExecutor;
}

const APK: EnvironmentProfile = profileFixture({
  distro: "alpine", distroFamily: "alpine", distroId: "alpine", versionId: "3.20.3",
  prettyName: "Alpine Linux v3.20", packageManager: "apk", serviceManager: "openrc",
  libc: "musl",
});

/** Fake `apk policy <pkg>` output: version lines end in `:`, each followed by
 *  indented source lines including an HTTPS repo URL (whose own `:` must not be
 *  read as a version). */
function fakeApkExecutor(policies: Record<string, string>): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      const m = cmd.match(/apk policy (\S+)/);
      if (m) {
        const out = policies[m[1]!];
        if (out === undefined) throw new Error("no such package");
        return out;
      }
      throw new Error("unexpected command");
    },
  } as unknown as CommandExecutor;
}

/** A host where no package manager was found — nothing to ask, and it says so. */
const NO_PM: EnvironmentProfile = profileFixture({ packageManager: "none" });

const status = (name: string, version: string): ComponentStatus => ({
  name, label: name, description: "", installable: true, installed: true, version, healthy: true, message: "",
});

describe("enrichAvailableVersions", () => {
  it("flags an update when the candidate is newer", async () => {
    const s = [status("git", "2.43.0")];
    await enrichAvailableVersions(fakeExecutor({ git: "1:2.44.0-1ubuntu1" }), APT, s);
    expect(s[0]!.updateAvailable).toBe(true);
    expect(s[0]!.availableVersion).toBe("2.44.0");
  });

  it("does NOT flag when installed == candidate", async () => {
    const s = [status("rsync", "3.2.7")];
    await enrichAvailableVersions(fakeExecutor({ rsync: "3.2.7-1" }), APT, s);
    expect(s[0]!.updateAvailable).toBeUndefined();
    expect(s[0]!.availableVersion).toBeUndefined();
  });

  it("does NOT flag a downgrade (candidate older than installed)", async () => {
    const s = [status("git", "2.43.0")];
    await enrichAvailableVersions(fakeExecutor({ git: "2.40.0-1" }), APT, s);
    expect(s[0]!.updateAvailable).toBeUndefined();
  });

  it("skips docker (no tracked package) and never throws on probe failure", async () => {
    const s = [
      { ...status("docker", "27.0.0") },
      status("certbot", "2.9.0"), // executor throws for certbot (no candidate)
    ];
    await expect(
      enrichAvailableVersions(fakeExecutor({}), APT, s),
    ).resolves.toBeUndefined();
    expect(s[0]!.updateAvailable).toBeUndefined();
    expect(s[1]!.updateAvailable).toBeUndefined();
  });

  it("skips components that aren't installed / have no version", async () => {
    const s: ComponentStatus[] = [
      { name: "git", label: "git", description: "", installable: true, installed: false, healthy: false, message: "" },
    ];
    await enrichAvailableVersions(fakeExecutor({ git: "2.44.0-1" }), APT, s);
    expect(s[0]!.updateAvailable).toBeUndefined();
  });

  it("apk: reads the newest version line, not the repo URL that follows it", async () => {
    const policy = [
      "git policy:",
      "  2.30.0-r0:",
      "    lib/apk/db/installed",
      "  2.43.0-r0:",
      "    https://dl-cdn.alpinelinux.org/alpine/v3.19/main",
      "",
    ].join("\n");
    const s = [status("git", "2.30.0")];
    await enrichAvailableVersions(fakeApkExecutor({ git: policy }), APK, s);
    expect(s[0]!.availableVersion).toBe("2.43.0");
    expect(s[0]!.updateAvailable).toBe(true);
  });

  // The point of asking `envOps` before the executor: on a host with nothing to ask,
  // we don't shell out to discover that. A badge nobody can compute is not a probe.
  it("makes no probe at all on a host with no package manager", async () => {
    const exec = vi.fn(async () => "");
    const s = [status("git", "2.43.0")];

    await enrichAvailableVersions({ exec } as unknown as CommandExecutor, NO_PM, s);

    expect(exec).not.toHaveBeenCalled();
    expect(s[0]!.updateAvailable).toBeUndefined();
  });

  it("apk: does NOT flag when the only available version equals installed", async () => {
    const policy = [
      "rsync policy:",
      "  3.2.7-r0:",
      "    lib/apk/db/installed",
      "    https://dl-cdn.alpinelinux.org/alpine/v3.19/main",
      "",
    ].join("\n");
    const s = [status("rsync", "3.2.7")];
    await enrichAvailableVersions(fakeApkExecutor({ rsync: policy }), APK, s);
    expect(s[0]!.updateAvailable).toBeUndefined();
    expect(s[0]!.availableVersion).toBeUndefined();
  });
});
