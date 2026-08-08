import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The container→host SSH channel is what every "this machine" operation runs
 * through once the API is containerized: deploys to this box, the :80/:443
 * takeover, the host terminal. `openship up` provisions it — and used to swallow
 * every reason it couldn't, writing an `.env` with no OPENSHIP_HOST_SSH_* keys,
 * reporting a healthy install, and leaving the first deploy to fail with "no host
 * channel is configured (OPENSHIP_HOST_SSH_HOST is unset)" (#509). One missing
 * `ssh-keygen` was enough, and re-running `openship up` — what that error tells
 * you to do — silently did the same thing again.
 *
 * These pin: a failure to provision is REPORTED with its cause, a deliberate
 * absence is not, and `doctor` can tell an install that has a channel from one
 * that only thinks it does.
 */

const h = vi.hoisted(() => ({
  existing: new Set<string>(),
  written: new Map<string, string>(),
  /** `ssh-keygen` is absent from this box (no openssh-client). */
  noKeygen: false,
  /** `ssh-keygen` runs but fails (full disk, unwritable key dir, …). */
  keygenFails: false,
}));

vi.mock("node:child_process", () => ({
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "ssh-keygen") {
      if (h.noKeygen)
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("spawnSync ssh-keygen ENOENT"),
        };
      if (h.keygenFails) return { status: 1, stdout: "", stderr: "", error: undefined };
      // A real keygen writes both halves; the provisioner reads the public one.
      const keyPath = String(args[args.indexOf("-f") + 1]);
      h.written.set(keyPath, "PRIVATE");
      h.written.set(
        `${keyPath}.pub`,
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest openship-host-executor",
      );
      h.existing.add(keyPath);
      h.existing.add(`${keyPath}.pub`);
      return { status: 0, stdout: "", stderr: "", error: undefined };
    }
    // `docker compose pull/up` succeed; everything else (volume inspect, ps) comes
    // back empty — no pre-existing db volume, no published ports, no orphaned stack.
    if (cmd === "docker" && args[0] === "compose")
      return { status: 0, stdout: "", stderr: "", error: undefined };
    return { status: 1, stdout: "", stderr: "", error: undefined };
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  chmodSync: () => undefined,
  readFileSync: (p: string) => {
    const v = h.written.get(String(p));
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
  },
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/op",
  userInfo: () => ({ username: "op" }),
}));

vi.mock("../../src/lib/source-install", () => ({ readSourceInstall: () => null }));

vi.mock("@repo/adapters/proxy", () => ({ sanitizeEdgeVhosts: async () => {} }));

vi.mock("@repo/adapters", async () => {
  const lua = await import("../../../../packages/adapters/src/infra/openresty-lua");
  return {
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
  };
});

import { composeHostChannel, composePaths, composeUp } from "../../src/lib/compose";

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** The `.env` this run wrote, parsed back into key → value. */
function writtenEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (h.written.get(composePaths.env) ?? "").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

let stderr: string[] = [];

beforeEach(() => {
  h.existing = new Set();
  h.written = new Map();
  h.noKeygen = false;
  h.keygenFails = false;
  stderr = [];
  // The compose install is Linux-only, so provisioning never runs on the platform
  // these tests happen to be executed on.
  setPlatform("linux");
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe("openship up — host channel provisioning", () => {
  it("reports the reason when the channel can't be provisioned", async () => {
    h.noKeygen = true;
    await composeUp({});
    // The install genuinely has no channel…
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    // …so it must say so, naming the cause and what it costs. Silence here is
    // what shipped a box that reports success and cannot deploy.
    const said = stderr.join("\n");
    expect(said).toMatch(/ssh-keygen/);
    expect(said).toMatch(/host/i);
    expect(said).toMatch(/openship doctor/);
  });

  it("reports a keygen that runs but fails, too", async () => {
    h.keygenFails = true;
    await composeUp({});
    expect(stderr.join("\n")).toMatch(/ssh-keygen/);
  });

  it("says nothing when the channel is provisioned", async () => {
    await composeUp({});
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    expect(stderr.join("\n")).not.toMatch(/host channel/i);
  });

  it("says nothing when the operator asked for no host control", async () => {
    h.noKeygen = true;
    await composeUp({ noHostControl: true });
    expect(stderr.join("\n")).not.toMatch(/host channel/i);
  });
});

describe("composeHostChannel — what doctor reports", () => {
  it("passes an install that has a channel", async () => {
    await composeUp({});
    expect(composeHostChannel()).toEqual({
      state: "pass",
      detail: "SSH to host.docker.internal as op",
    });
  });

  it("fails an install whose `.env` has no channel", async () => {
    h.noKeygen = true;
    await composeUp({});
    const c = composeHostChannel();
    expect(c.state).toBe("fail");
    expect(c.detail).toMatch(/deploys to this box will fail/i);
  });

  it("fails a channel whose key has gone missing", async () => {
    await composeUp({});
    h.existing.delete(writtenEnv().OPENSHIP_HOST_KEY_PATH);
    expect(composeHostChannel().state).toBe("fail");
  });

  it("treats an opted-out install as fine, not broken", async () => {
    await composeUp({ noHostControl: true });
    expect(composeHostChannel().state).toBe("pass");
  });
});
