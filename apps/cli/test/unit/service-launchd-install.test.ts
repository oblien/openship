import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const home = `${process.env.TMPDIR || "/tmp"}/openship-launchd-install-${process.pid}`;
  process.env.OPENSHIP_HOME = `${home}/.openship`;
  return { home };
});
// The agent's plist goes under homedir(); keep it out of the real ~/Library.
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("@repo/adapters", () => ({
  LocalExecutor: class {},
  probeListeningPortOwners: vi.fn(),
}));

/**
 * A small launchd. Like the real one, `bootout` returns before the job is gone:
 * the label stays loaded for `unloadPolls` more `launchctl list` calls, and a
 * `bootstrap` of a label that is still loaded fails with EIO. `load -w` exits 0
 * even when it prints "Load failed".
 */
const launchd = vi.hoisted(() => ({
  loaded: false,
  pid: null as number | null,
  stopping: 0,
  unloadPolls: 0,
  startsProcess: true,
  bootstrapFails: false,
  bootoutFails: false,
  listFails: false,
  calls: [] as string[],
}));
const NEW_PID = 4321;

function start(): void {
  launchd.loaded = true;
  launchd.pid = launchd.startsProcess ? NEW_PID : null;
}

const commands = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: commands,
}));
const { installAndStart, preview } = await import("../../src/lib/service");

const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  mkdirSync(state.home, { recursive: true });
  Object.assign(launchd, {
    loaded: false,
    pid: null,
    stopping: 0,
    unloadPolls: 0,
    startsProcess: true,
    bootstrapFails: false,
    bootoutFails: false,
    listFails: false,
    calls: [],
  });
  commands.mockReset().mockImplementation((command: string, args: string[]) => {
    if (command !== "launchctl") return { status: 0, stdout: "", stderr: "" };
    const sub = args[0];
    launchd.calls.push(sub);
    if (sub === "bootout") {
      if (!launchd.loaded) return { status: 3, stdout: "", stderr: "No such process" };
      if (launchd.bootoutFails) {
        return { status: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error" };
      }
      launchd.pid = null;
      launchd.stopping = launchd.unloadPolls;
      if (launchd.stopping === 0) launchd.loaded = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (sub === "list") {
      if (launchd.listFails) return { status: 5, stdout: "", stderr: "Input/output error" };
      if (!launchd.loaded) {
        return { status: 113, stdout: "", stderr: `Could not find service "${args[1]}"` };
      }
      if (launchd.stopping > 0 && --launchd.stopping === 0) launchd.loaded = false;
      const stdout = launchd.pid != null ? `"PID" = ${launchd.pid};` : `"LastExitStatus" = 256;`;
      return { status: 0, stdout, stderr: "" };
    }
    if (sub === "bootstrap") {
      if (launchd.loaded || launchd.bootstrapFails) {
        return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      start();
      return { status: 0, stdout: "", stderr: "" };
    }
    if (sub === "load") {
      if (launchd.loaded || launchd.bootstrapFails) {
        return { status: 0, stdout: "", stderr: "Load failed: 5: Input/output error" };
      }
      start();
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.restoreAllMocks();
});
afterAll(() => rmSync(state.home, { recursive: true, force: true }));

describe("installAndStart on launchd", () => {
  it("installs and starts an agent that isn't loaded yet", () => {
    expect(installAndStart({ port: "7100" }).kind).toBe("launchd");
    expect(launchd.pid).toBe(NEW_PID);
  });

  it("waits for the running agent to unload before bootstrapping it again", () => {
    // A re-run of `openship up` while the service is running.
    Object.assign(launchd, { loaded: true, pid: 1111, unloadPolls: 3 });

    expect(installAndStart({ port: "7100" }).kind).toBe("launchd");

    expect(launchd.pid).toBe(NEW_PID);
    expect(launchd.calls).not.toContain("load");
  });

  it.each([
    { setup: { bootoutFails: true }, error: /still loaded after 10s.*Boot-out failed/ },
    { setup: { unloadPolls: 100 }, error: /still loaded after 10s/ },
    { setup: { listFails: true }, error: /Couldn't check launchd agent.*Input\/output error/ },
  ])(
    "preserves the existing plist when unloading cannot be confirmed: $setup",
    ({ setup, error }) => {
      const flags = { port: "7100" };
      installAndStart(flags);
      const { path } = preview(flags);
      const installed = readFileSync(path, "utf8");
      launchd.calls.length = 0;
      Object.assign(launchd, setup);

      expect(() => installAndStart({ port: "7300" })).toThrow(error);
      expect(readFileSync(path, "utf8")).toBe(installed);
      expect(launchd.calls).not.toContain("bootstrap");
      expect(launchd.calls).not.toContain("load");
    },
  );

  it("fails instead of reporting success when the agent doesn't stay up", () => {
    launchd.startsProcess = false;

    expect(() => installAndStart({ port: "7100" })).toThrow(/didn't start \(last exit 256\)/);
  }, 10_000);

  it("fails when `launchctl load` prints Load failed and still exits 0", () => {
    launchd.bootstrapFails = true;

    expect(() => installAndStart({ port: "7100" })).toThrow(/didn't start.*Load failed/);
  }, 10_000);
});
