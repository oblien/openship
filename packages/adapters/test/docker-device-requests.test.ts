import { describe, expect, it } from "vitest";
import { toDeviceRequests } from "../src/runtime/docker";

describe("toDeviceRequests", () => {
  it("is undefined when no GPU is asked for (no key reaches Docker)", () => {
    expect(toDeviceRequests(undefined)).toBeUndefined();
    expect(toDeviceRequests(null)).toBeUndefined();
  });

  it("builds exactly what `docker run --gpus all` sends", () => {
    expect(toDeviceRequests({ driver: "nvidia", count: "all", capabilities: ["gpu"] })).toEqual([
      { Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] },
    ]);
  });

  it("treats a missing count and a missing driver as all GPUs on nvidia", () => {
    expect(toDeviceRequests({})).toEqual([
      { Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] },
    ]);
  });

  it("keeps a numeric count", () => {
    expect(toDeviceRequests({ count: 2 })).toEqual([
      { Driver: "nvidia", Count: 2, Capabilities: [["gpu"]] },
    ]);
  });

  it("sends DeviceIDs WITHOUT Count (the daemon rejects both together)", () => {
    const [req] = toDeviceRequests({ deviceIds: ["0", "GPU-abc"] }) as Record<string, unknown>[];
    expect(req.DeviceIDs).toEqual(["0", "GPU-abc"]);
    expect("Count" in req).toBe(false);
  });

  it("always includes the gpu capability and keeps the extra ones in ONE and-list", () => {
    expect(toDeviceRequests({ capabilities: ["compute", "utility"] })).toEqual([
      { Driver: "nvidia", Count: -1, Capabilities: [["compute", "utility", "gpu"]] },
    ]);
  });

  it("refuses unsupported drivers instead of silently deploying without a GPU", () => {
    expect(() => toDeviceRequests({ driver: "amd", capabilities: ["gpu"] })).toThrow(
      /only.*NVIDIA/,
    );
  });
});

it("maps every GPU group and driver option without changing explicit zero", () => {
  expect(
    toDeviceRequests([{ count: 0 }, { deviceIds: ["1"], options: { mode: "passthrough" } }]),
  ).toEqual([
    { Driver: "nvidia", Count: 0, Capabilities: [["gpu"]] },
    {
      Driver: "nvidia",
      DeviceIDs: ["1"],
      Capabilities: [["gpu"]],
      Options: { mode: "passthrough" },
    },
  ]);
});

it("refuses conflicting selectors instead of silently choosing one", () => {
  expect(() => toDeviceRequests({ deviceIds: ["0"], count: 1 })).toThrow(/cannot be combined/);
});

it("allows NVIDIA GPU selectors while refusing unrelated CDI host devices", () => {
  expect(
    toDeviceRequests({
      deviceIds: ["0", "0:1", "GPU-abc", "MIG-GPU-abc/1/0", "nvidia.com/gpu=0"],
    })?.[0]?.DeviceIDs,
  ).toEqual(["0", "0:1", "GPU-abc", "MIG-GPU-abc/1/0", "nvidia.com/gpu=0"]);
  expect(() => toDeviceRequests({ deviceIds: ["example.com/host-device=root"] })).toThrow(
    /must select NVIDIA/,
  );
});
