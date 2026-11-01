import { describe, expect, it } from "vitest";
import { effectiveGpu, UNKNOWN_CAPACITY } from "./resources";

describe("effectiveGpu", () => {
  it("follows the probe when there is no manual mark", () => {
    expect(effectiveGpu({ gpuRuntime: true }, null)).toEqual({
      hasGpu: true,
      count: null,
      source: "probe",
    });
    expect(effectiveGpu({ gpuRuntime: true, gpuCount: 1 }, null)).toEqual({
      hasGpu: true,
      count: 1,
      source: "probe",
    });
    expect(effectiveGpu({ gpuRuntime: false }, null)).toEqual({
      hasGpu: false,
      count: null,
      source: "none",
    });
    expect(effectiveGpu(UNKNOWN_CAPACITY, undefined).hasGpu).toBe(false);
    expect(effectiveGpu(undefined, undefined).hasGpu).toBe(false);
  });

  it("a daemon that lists a device counts even without the runtime flag", () => {
    expect(effectiveGpu({ gpuCount: 2 }, null)).toEqual({
      hasGpu: true,
      count: 2,
      source: "probe",
    });
  });

  it('a manual "yes" wins when the probe saw nothing', () => {
    expect(effectiveGpu({ gpuRuntime: false }, "yes")).toEqual({
      hasGpu: true,
      count: null,
      source: "override",
    });
    expect(effectiveGpu(UNKNOWN_CAPACITY, "yes").hasGpu).toBe(true);
  });

  it('a manual "no" wins over a probed card the operator reserves for the host', () => {
    expect(effectiveGpu({ gpuRuntime: true, gpuCount: 2 }, "no")).toEqual({
      hasGpu: false,
      count: null,
      source: "override",
    });
  });

  it('"yes" keeps the probed count so the UI can still show how many cards', () => {
    expect(effectiveGpu({ gpuCount: 2 }, "yes")).toEqual({
      hasGpu: true,
      count: 2,
      source: "override",
    });
  });
});
