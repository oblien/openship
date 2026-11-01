import { describe, expect, it } from "vitest";
import type { HostCapacity } from "@repo/core";
import { serverGpu } from "@repo/platform/engine/modules/system/server-view";

const t4: HostCapacity = {
  cpuCores: 8,
  memoryMb: 32768,
  source: "docker",
  gpuRuntime: true,
  gpuCount: 1,
};
const none: HostCapacity = { cpuCores: 8, memoryMb: 32768, source: "docker", gpuRuntime: false };

describe("serverGpu (API annotation)", () => {
  it("follows the probe with no manual mark", () => {
    expect(serverGpu(null, t4)).toEqual({
      available: true,
      detected: true,
      count: 1,
      override: null,
      probed: true,
    });
    expect(serverGpu(null, none)).toEqual({
      available: false,
      detected: false,
      count: null,
      override: null,
      probed: true,
    });
  });

  it('manual "yes" makes a probe-blind box available while still reporting detected:false', () => {
    expect(serverGpu("yes", none)).toEqual({
      available: true,
      detected: false,
      count: null,
      override: "yes",
      probed: true,
    });
  });

  it('manual "no" hides a detected card but keeps detected:true so the UI can show the mismatch', () => {
    expect(serverGpu("no", t4)).toEqual({
      available: false,
      detected: true,
      count: 1,
      override: "no",
      probed: true,
    });
  });

  it("an unreadable daemon is probed:false (UI must not read detected:false as 'no GPU')", () => {
    expect(serverGpu(null, null)).toEqual({
      available: false,
      detected: false,
      count: null,
      override: null,
      probed: false,
    });
    expect(serverGpu("yes", null)).toEqual({
      available: true,
      detected: false,
      count: null,
      override: "yes",
      probed: false,
    });
  });

  it("an 'unknown' source reading counts as not probed", () => {
    expect(serverGpu(null, { cpuCores: 0, memoryMb: 0, source: "unknown" }).probed).toBe(false);
  });
});
