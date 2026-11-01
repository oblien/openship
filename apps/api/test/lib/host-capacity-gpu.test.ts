import { describe, expect, it } from "vitest";
import { fromDockerInfo, gpuFromDockerInfo } from "@repo/platform/engine/lib/host-capacity";

/** Captured from `GET /info` on the Tesla T4 host (Docker 29.4.0, NVIDIA toolkit installed). */
const T4_INFO = {
  NCPU: 8,
  MemTotal: 33_500_000_000,
  DefaultRuntime: "runc",
  Runtimes: { "io.containerd.runc.v2": {}, nvidia: {}, runc: {} },
  DiscoveredDevices: [
    { Source: "cdi", ID: "nvidia.com/gpu=0" },
    { Source: "cdi", ID: "nvidia.com/gpu=GPU-86fecce1-e02a-3e95-9654-71f934a03b8d" },
    { Source: "cdi", ID: "nvidia.com/gpu=all" },
  ],
};

describe("gpuFromDockerInfo", () => {
  it("counts ONE card for the three CDI spellings of a single Tesla T4 (real /info)", () => {
    expect(gpuFromDockerInfo(T4_INFO)).toEqual({ gpuRuntime: true, gpuCount: 1 });
  });

  it("counts two cards by index", () => {
    expect(
      gpuFromDockerInfo({
        Runtimes: { nvidia: {} },
        DiscoveredDevices: [
          { ID: "nvidia.com/gpu=0" },
          { ID: "nvidia.com/gpu=1" },
          { ID: "nvidia.com/gpu=all" },
        ],
      }),
    ).toEqual({ gpuRuntime: true, gpuCount: 2 });
  });

  it("reports the runtime but leaves the count UNKNOWN on a daemon that lists no devices", () => {
    const got = gpuFromDockerInfo({ Runtimes: { nvidia: {}, runc: {} } });
    expect(got).toEqual({ gpuRuntime: true });
    expect("gpuCount" in got).toBe(false);
  });

  it("is gpuRuntime:false (not absent) when the daemon was read and has no nvidia runtime", () => {
    expect(gpuFromDockerInfo({ Runtimes: { runc: {} } })).toEqual({ gpuRuntime: false });
  });

  it("says nothing when /info has neither field", () => {
    expect(gpuFromDockerInfo({ NCPU: 4 })).toEqual({});
  });

  it("ignores non-NVIDIA CDI devices and MIG slices", () => {
    expect(
      gpuFromDockerInfo({
        Runtimes: {},
        DiscoveredDevices: [{ ID: "amd.com/gpu=0" }, { ID: "nvidia.com/gpu=0:0" }],
      }),
    ).toEqual({ gpuRuntime: false });
  });
});

describe("fromDockerInfo", () => {
  it("carries the GPU signals next to cpu and memory", () => {
    expect(fromDockerInfo(T4_INFO)).toMatchObject({
      cpuCores: 8,
      source: "docker",
      gpuRuntime: true,
      gpuCount: 1,
    });
  });

  it("still returns null when there is no cpu/memory (GPU signals do not rescue it)", () => {
    expect(fromDockerInfo({ Runtimes: { nvidia: {} } })).toBeNull();
  });
});
