import { describe, expect, it, vi } from "vitest";

import { DockerRuntime } from "./docker";

function runtimeWithDocker(docker: Record<string, unknown>): DockerRuntime {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & Record<string, unknown>;
  Object.assign(runtime, {
    connectionOptions: {},
    transport: {
      kind: "socket",
      description: "test socket",
      unreachableHint: "test daemon is unavailable",
    },
    systemManager: null,
    _docker: docker,
  });
  return runtime;
}

describe("DockerRuntime cleanup error semantics", () => {
  it("treats an absent container as an empty volume inventory", async () => {
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error("no such container"), { statusCode: 404 });
    });
    const runtime = runtimeWithDocker({ getContainer: () => ({ inspect }) });

    await expect(runtime.inspectNamedVolumes("gone")).resolves.toEqual([]);
  });

  it("does not turn a failed volume inventory into an empty one", async () => {
    const inspect = vi.fn(async () => {
      throw new Error("daemon connection lost");
    });
    const runtime = runtimeWithDocker({ getContainer: () => ({ inspect }) });

    await expect(runtime.inspectNamedVolumes("still-there")).rejects.toThrow(
      "daemon connection lost",
    );
  });

  it.each([
    ["volume", (runtime: DockerRuntime) => runtime.removeVolume("data")],
    ["network", (runtime: DockerRuntime) => runtime.removeNetwork("app")],
  ])("propagates a real %s removal failure", async (kind, remove) => {
    const failure = vi.fn(async () => {
      throw new Error(`${kind} is still in use`);
    });
    const runtime = runtimeWithDocker({
      getVolume: () => ({ remove: failure }),
      getNetwork: () => ({ remove: failure }),
    });

    await expect(remove(runtime)).rejects.toThrow(`${kind} is still in use`);
  });
});
