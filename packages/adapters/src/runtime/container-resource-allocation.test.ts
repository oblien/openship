import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

describe("applied container resource allocations", () => {
  it.each([
    [{ NanoCpus: 500_000_000, Memory: 512 * 1024 * 1024 }, { cpuCores: 0.5, memoryMb: 512 }],
    [{ CpuQuota: 200_000, CpuPeriod: 100_000, Memory: 2048 * 1024 * 1024 }, { cpuCores: 2, memoryMb: 2048 }],
    [{ NanoCpus: 0, Memory: 0 }, { cpuCores: 0, memoryMb: 0 }],
  ])("reports Docker's applied caps, including unlimited values", async (hostConfig, expected) => {
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-test-absent.sock" });
    (runtime as unknown as { _docker: unknown })._docker = {
      getContainer: () => ({ inspect: async () => ({ HostConfig: hostConfig,
        State: { Status: "exited", Running: false }, NetworkSettings: { Networks: {} } }) }),
    };
    expect(await runtime.getContainerInfo("stopped-container")).toMatchObject({ status: "stopped", resources: expected });
  });
});
