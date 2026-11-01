import { describe, expect, it } from "vitest";
import type { HostCapacity } from "@repo/core";
import { gpuTargetCheck, servicesRequestingGpu } from "@repo/platform/engine/lib/gpu-target";

const withGpu: HostCapacity = {
  cpuCores: 8,
  memoryMb: 32768,
  source: "docker",
  gpuRuntime: true,
  gpuCount: 1,
};
const noGpu: HostCapacity = { cpuCores: 8, memoryMb: 32768, source: "docker", gpuRuntime: false };

const svc = (name: string, gpus?: object) =>
  ({ name, advanced: gpus ? { gpus } : undefined }) as never;

describe("servicesRequestingGpu", () => {
  it("lists only the services that carry advanced.gpus", () => {
    expect(servicesRequestingGpu([svc("api"), svc("worker", { count: "all" }), svc("db")])).toEqual(
      ["worker"],
    );
    expect(servicesRequestingGpu(undefined)).toEqual([]);
    expect(servicesRequestingGpu([])).toEqual([]);
  });
});

it("includes legacy runtime services and skips explicit zero/empty request lists", () => {
  expect(
    servicesRequestingGpu([
      { name: "legacy", advanced: { runtime: "nvidia" } },
      { name: "none", advanced: { gpus: { count: 0 } } },
      { name: "empty", advanced: { gpus: [] } },
    ] as never),
  ).toEqual(["legacy"]);
});

describe("gpuTargetCheck (warn-only)", () => {
  it("says nothing when no service wants a GPU", () => {
    expect(gpuTargetCheck({ gpuServices: [], override: null, capacity: noGpu })).toBeNull();
  });

  it("passes on a server whose daemon reports the nvidia runtime", () => {
    expect(
      gpuTargetCheck({ gpuServices: ["rag"], override: null, capacity: withGpu })?.status,
    ).toBe("pass");
  });

  it("WARNS (never fails) when the daemon was read and has no GPU", () => {
    const check = gpuTargetCheck({
      gpuServices: ["rag", "worker-media"],
      override: null,
      capacity: noGpu,
    });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain('"rag", "worker-media"');
    expect(check?.message).toContain("mark this server as having a GPU");
  });

  it('a manual "yes" silences the warning even when the probe saw nothing', () => {
    expect(gpuTargetCheck({ gpuServices: ["rag"], override: "yes", capacity: noGpu })?.status).toBe(
      "pass",
    );
  });

  it('a manual "yes" also works when the daemon could not be read at all', () => {
    expect(gpuTargetCheck({ gpuServices: ["rag"], override: "yes", capacity: null })?.status).toBe(
      "pass",
    );
  });

  it('a manual "no" warns even on a box the probe says has a card, and names the mark', () => {
    const check = gpuTargetCheck({ gpuServices: ["rag"], override: "no", capacity: withGpu });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain('marked "no GPU"');
  });

  it("says nothing when the daemon was unreachable (reachability checks already speak for the box)", () => {
    expect(gpuTargetCheck({ gpuServices: ["rag"], override: null, capacity: null })).toBeNull();
  });

  it("never returns a failing status in any combination", () => {
    for (const override of ["yes", "no", null] as const)
      for (const capacity of [withGpu, noGpu, null])
        expect(gpuTargetCheck({ gpuServices: ["a"], override, capacity })?.status).not.toBe("fail");
  });
});
