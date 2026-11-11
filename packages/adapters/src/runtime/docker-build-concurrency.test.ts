import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

const GiB = 1024 ** 3;
function fixture(memory = 8 * GiB, cpu = 4, available = memory, usedCpu = 0) {
  const stats = {
    cpu: usedCpu,
    memTotal: memory,
    memAvail: available,
    memUsed: memory - available,
    diskTotal: 100 * GiB,
    diskUsed: 0,
    diskAvail: 100 * GiB,
    uptime: "1",
    load1: "0",
    load5: "0",
    load15: "0",
  };
  const daemon = { NCPU: cpu, MemTotal: memory };
  const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
    connectionOptions: { executor: { exec: vi.fn(async () => JSON.stringify(stats)) } },
    _docker: { info: vi.fn(async () => daemon) },
  });
  const run = (resources = { cpuCores: 0, memoryMb: 0 }) =>
    runtime.batchBuildConcurrency({ resources }, 10);
  return { runtime, daemon, stats, run };
}

describe("build concurrency on the deployment host", () => {
  it("leaves memory for running apps and caps simultaneous compiler processes", async () => {
    expect(await fixture().run()).toBe(3);
    expect(await fixture(32 * GiB, 32).run()).toBe(4);
    expect(await fixture(8 * GiB, 4, 3 * GiB).run()).toBe(1);
    expect(await fixture(8 * GiB, 4, 8 * GiB, 75).run()).toBe(1);
  });
  it("uses the entire worker's declared budget, not that budget per service", async () => {
    expect(await fixture().run({ cpuCores: 1, memoryMb: 4096 })).toBe(1);
    expect(await fixture().run({ cpuCores: 4, memoryMb: 512 })).toBe(1);
  });
  it("stays serial when host and daemon measurements refer to different machines", async () => {
    const h = fixture();
    h.daemon.MemTotal *= 2;
    expect(await h.run()).toBe(1);
    h.runtime.connectionOptions.executor.exec.mockRejectedValue(new Error("host unavailable"));
    expect(await h.run()).toBe(1);
  });
});
