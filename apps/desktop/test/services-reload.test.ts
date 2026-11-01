import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  spawn: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/isolated-desktop-fixture" },
  net: { fetch: mocks.fetch },
  utilityProcess: { fork: mocks.fork },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: (path: string) =>
    path.endsWith("auth-secret") ? "desktop-reload-fixture-auth-secret-000000000000" : "{}",
}));
vi.mock("@repo/core/ports", () => ({
  resolvePortPair: async () => ({ api: 45111, dashboard: 45112 }),
}));

class Child extends EventEmitter {
  stdout = null;
  stderr = null;
  postMessage() {}
  kill = vi.fn(() => this.emit("exit", 0));
}

let services: typeof import("../src/main/services");
const children: Child[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal(
    "process",
    Object.assign(Object.create(process), {
      resourcesPath: "/isolated-desktop-resources",
    }),
  );
  mocks.fork.mockReset().mockImplementation(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
  mocks.spawn.mockReset();
  mocks.fetch.mockReset().mockResolvedValue({ status: 200 });
  services = await import("../src/main/services");
});

afterEach(() => {
  services.stopLocalServices();
  children.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Desktop API reload ownership", () => {
  it("restarts only the API after exit 75, preserving its data directory, keys and origin", async () => {
    await services.startLocalServices("fixture-internal-token");
    const original = mocks.fork.mock.calls.find(([entry]) => entry.endsWith("server/index.js"))!;
    const api = children[mocks.fork.mock.calls.indexOf(original)]!;
    api.emit("exit", 75);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.fork).toHaveBeenCalledTimes(3);
    expect(mocks.fork.mock.calls[2]).toEqual(original);
    expect(services.getLocalApiUrl()).toBe("http://127.0.0.1:45111");
    expect(services.getLocalDashboardUrl()).toBe("http://127.0.0.1:45112");
    expect(children[1]!.kill).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();

    children[2]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fork).toHaveBeenCalledTimes(3); // normal failures are not reloads
  });

  it("awaits an API that is still booting during a reload and cannot resurrect it after update shutdown", async () => {
    await services.startLocalServices("fixture-internal-token");
    let health!: (value: { status: number }) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          health = resolve;
        }),
    );
    children[0]!.emit("exit", 75);
    const reloading = children[2]!;
    reloading.kill.mockImplementation(() => true); // process has not released PGlite yet

    let stopped = false;
    const stop = services.stopLocalServicesAndWait().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reloading.kill).toHaveBeenCalled();
    expect(stopped).toBe(false);
    reloading.emit("exit", 75);
    await stop;
    health({ status: 200 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(stopped).toBe(true);
    expect(mocks.fork).toHaveBeenCalledTimes(3);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("ignores a late reload exit after Desktop quits", async () => {
    await services.startLocalServices("fixture-internal-token");
    const api = children[0]!;
    services.stopLocalServices();
    api.emit("exit", 75);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fork).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
