import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const home = `${process.env.TMPDIR || "/tmp"}/openship-service-owners-${process.pid}`;
  process.env.OPENSHIP_HOME = home;
  return { home, pid: 4200, processes: "4200 1\n4201 4200\n4202 4201\n9000 1", probe: vi.fn() };
});
vi.mock("@repo/adapters", () => ({
  LocalExecutor: class {},
  probeListeningPortOwners: state.probe,
}));
vi.mock("../../src/lib/this-host", () => ({
  thisHost: () => ({ profile: { serviceManager: "systemd" } }),
}));
const commands = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: commands,
}));
const { serviceHeldPorts } = await import("../../src/lib/service");
const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  mkdirSync(state.home, { recursive: true });
  writeFileSync(join(state.home, "ports.json"), JSON.stringify({ api: 7100, dashboard: 7200 }));
  state.pid = 4200;
  state.processes = "4200 1\n4201 4200\n4202 4201\n9000 1";
  state.probe.mockReset().mockResolvedValue({
    checked: true,
    ownershipComplete: true,
    occupants: [{ pid: 4202 }],
  });
  commands.mockReset().mockImplementation((command, args) => {
    const stdout =
      command === "launchctl"
        ? `"PID" = ${state.pid};`
        : command === "systemctl"
          ? String(state.pid)
          : command === "ps"
            ? state.processes
            : "";
    return { status: 0, stdout, stderr: "" };
  });
});
afterEach(() =>
  Object.defineProperty(process, "platform", { value: platform, configurable: true }),
);
afterAll(() => rmSync(state.home, { recursive: true, force: true }));

describe("service-held listener ownership", () => {
  it("accepts listeners belonging to the service and nested children", async () => {
    expect(await serviceHeldPorts()).toEqual([7100, 7200]);
  });
  it("rejects a foreign dashboard listener even while the API service runs", async () => {
    state.probe.mockImplementation(async (_, port) => ({
      checked: true,
      ownershipComplete: true,
      occupants: [{ pid: port === 7100 ? 4201 : 9000 }],
    }));
    expect(await serviceHeldPorts()).toEqual([7100]);
  });
  it("rejects mixed owners, hidden owners and incomplete ownership", async () => {
    for (const result of [
      { checked: true, ownershipComplete: true, occupants: [{ pid: 4201 }, { pid: 9000 }] },
      { checked: true, ownershipComplete: false, occupants: [{ pid: 4201 }] },
      { checked: true, ownershipComplete: true, occupants: [{ pid: null }] },
      { checked: false, ownershipComplete: false, occupants: [] },
    ]) {
      state.probe.mockResolvedValue(result);
      expect(await serviceHeldPorts()).toEqual([]);
    }
  });
  it("does not trust a saved port when its owner is outside the live service tree", async () => {
    state.probe.mockResolvedValue({
      checked: true,
      ownershipComplete: true,
      occupants: [{ pid: 9000 }],
    });
    expect(await serviceHeldPorts()).toEqual([]);
  });
  it("falls back when the service is stopped or its process tree is unavailable", async () => {
    state.pid = 0;
    expect(await serviceHeldPorts()).toEqual([]);
    expect(state.probe).not.toHaveBeenCalled();
    state.pid = 4200;
    state.processes = "9000 1";
    expect(await serviceHeldPorts()).toEqual([]);
    expect(state.probe).not.toHaveBeenCalled();
  });
  it("uses the live systemd MainPID for Linux services", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(await serviceHeldPorts()).toEqual([7100, 7200]);
    expect(
      commands.mock.calls.some(
        ([command, args]) => command === "systemctl" && args.includes("--property=MainPID"),
      ),
    ).toBe(true);
  });
  it("does not guess ownership for a scheduled task without a PID", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(await serviceHeldPorts()).toEqual([]);
    expect(state.probe).not.toHaveBeenCalled();
  });
  it("ignores malformed stored ports without invoking an ownership probe", async () => {
    writeFileSync(join(state.home, "ports.json"), JSON.stringify({ api: "7100", dashboard: -1 }));
    expect(await serviceHeldPorts()).toEqual([]);
    expect(state.probe).not.toHaveBeenCalled();
  });
});
