/**
 * The sync detector, on the one axis where it can disagree with the async one.
 *
 * Both paths run the same script through the same parser, so nothing here re-tests
 * detection — `environment.test.ts` owns that. What only this path can get wrong is the
 * probe it hands the parser: it builds `EnvironmentProbe` by hand from a `spawnSync`
 * result, and the flag it fills in decides whether the bytes on the streams are read as
 * the host's answer or as our own noise.
 *
 * Runs under `bun test` as well as vitest on purpose: `spawnSync`'s result shape is the
 * input under test, and the two runtimes are two implementations of it.
 */

import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

import { probeOutput } from "./environment.fixtures";

type SpawnResult = {
  status?: number | null;
  signal?: string | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
};

/**
 * Staged per test and read at call time, so the hoisted factory never touches it early.
 *
 * Mocked at the module boundary rather than behind an injectable spawn: a seam wide enough
 * to test with would be a second way to reach a profile, which is the thing this module
 * exists to prevent.
 */
let staged: SpawnResult = {};
vi.mock("node:child_process", () => ({
  // Partial, via `require` because vitest's `importOriginal` argument does not exist under
  // `bun test`: the module graph behind `./executor` reaches the SSH stack, which promisifies
  // the real `execFile` at import time and dies on a mock that only has `spawnSync`.
  ...createRequire(import.meta.url)("node:child_process"),
  spawnSync: () => staged,
}));

async function probeThisMachine(result: SpawnResult) {
  staged = result;
  const local = await import("./environment-local");
  local.invalidateLocalEnvironment();
  return local.resolveLocalEnvironmentSync();
}

describe("a local probe that was killed", () => {
  /**
   * A signal kill means no exit status, and no exit status means nothing answered — the
   * fact the SSH path meets as ssh2's "closed without an exit status". Read as an answer
   * instead, the streams of a killed spawn accuse THIS machine's sshd of a forced command,
   * and the text quoted as the box's banner is our own probe's first line.
   */
  it.each([
    ["partial probe output", { stdout: `opsh_begin=1\nopsh_os=Linux\n`, stderr: "" }],
    ["signal noise on stderr", { stdout: "", stderr: "Killed\n" }],
    ["nothing at all", { stdout: "", stderr: "" }],
  ])("reads a SIGKILL with %s as unmeasured", async (_label, streams) => {
    const profile = await probeThisMachine({ status: null, signal: "SIGKILL", ...streams });

    expect(profile.forcedCommand).toBeNull();
    expect(profile.probeError).toBeTruthy();
    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("killed");
    // Specifically not the forced-command reason: it sends the operator to authorized_keys
    // on a box that has no sshd in the picture at all.
    expect(profile.unsupportedReason).not.toMatch(/forced command|ForceCommand|ec2-user/i);
    // And not our own script's output handed back as something the machine said.
    expect(profile.unsupportedReason).not.toContain("opsh_");
  });

  it("names the signal, and does not claim a shell was unreachable", async () => {
    const profile = await probeThisMachine({ status: null, signal: "SIGTERM", stdout: "" });

    expect(profile.unsupportedReason).toContain("SIGTERM");
    expect(profile.unsupportedReason).not.toMatch(/could not run a shell/i);
  });

  /** Bun and Node both report a timed-out `spawnSync` as an error, not as a bare signal. */
  it("still refuses a spawn that never started", async () => {
    const error = Object.assign(new Error("spawnSync sh ENOENT"), { code: "ENOENT" });
    const profile = await probeThisMachine({ status: null, signal: null, error });

    expect(profile.supported).toBe(false);
    expect(profile.unsupportedReason).toContain("could not run a shell");
    expect(profile.forcedCommand).toBeNull();
  });
});

describe("a local probe that exited on its own", () => {
  /**
   * The other half of the rule, or the fix would be a rule that refuses everything: a
   * process that chose its own exit code answered, and its text is the machine's — the
   * shape `assessHostSupport` words for "a shell that cannot run the script at all".
   */
  it("keeps a non-zero exit's output as what the machine said", async () => {
    const profile = await probeThisMachine({
      status: 126,
      signal: null,
      stdout: "",
      stderr: "sh: /etc/profile: Permission denied\n",
    });

    expect(profile.forcedCommand).toContain("Permission denied");
    expect(profile.probeError).toBeNull();
    expect(profile.supported).toBe(false);
  });

  it("measures a healthy machine", async () => {
    const profile = await probeThisMachine({
      status: 0,
      signal: null,
      stdout: probeOutput({ os: "Darwin", arch: "arm64", pm: "brew", sm: "launchd" }),
      stderr: "",
    });

    expect(profile).toMatchObject({
      os: "darwin",
      arch: "arm64",
      packageManager: "brew",
      supported: true,
      probeError: null,
      forcedCommand: null,
    });
  });
});
