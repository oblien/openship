import { describe, expect, it } from "vitest";

import {
  dockerResourceLimits,
  dockerBuildResourceLimits,
  inspectResourceLimits,
  describeResourceLimits,
} from "../src/runtime/resource-limits";

// The bug this guards (#333): every self-hosted container was created with
// HostConfig.Memory = 536870912 because the cloud free tier was used as a
// fallback. `0`/absent must produce NO key at all, so Docker leaves the
// container uncapped and it inherits the machine.
describe("dockerResourceLimits", () => {
  it("omits both keys entirely when nothing is capped", () => {
    expect(dockerResourceLimits({ cpuCores: 0, memoryMb: 0, diskMb: 0 })).toEqual({});
    expect(dockerResourceLimits(undefined)).toEqual({});
    expect(dockerResourceLimits(null)).toEqual({});
    expect(dockerResourceLimits({})).toEqual({});
  });

  it("never emits the old 512 MB default for an unset config", () => {
    const limits = dockerResourceLimits(undefined);
    expect(limits.Memory).toBeUndefined();
    expect(limits.Memory).not.toBe(536_870_912);
  });

  it("converts memory MB → bytes", () => {
    expect(dockerResourceLimits({ memoryMb: 512 }).Memory).toBe(536_870_912);
    expect(dockerResourceLimits({ memoryMb: 3072 }).Memory).toBe(3_221_225_472);
  });

  it("caps CPU with NanoCpus, not the no-op CpuShares weight", () => {
    const limits = dockerResourceLimits({ cpuCores: 2 }) as Record<string, number>;
    expect(limits.NanoCpus).toBe(2_000_000_000);
    expect(limits.CpuShares).toBeUndefined();
  });

  it("supports fractional cores and respects Docker's 1e6 nano floor", () => {
    expect(dockerResourceLimits({ cpuCores: 0.5 }).NanoCpus).toBe(500_000_000);
    expect(dockerResourceLimits({ cpuCores: 0.0000001 }).NanoCpus).toBe(1_000_000);
  });

  it("caps one dimension independently of the other", () => {
    expect(dockerResourceLimits({ cpuCores: 0, memoryMb: 2048 })).toEqual({
      Memory: 2_147_483_648,
    });
    expect(dockerResourceLimits({ cpuCores: 1, memoryMb: 0 })).toEqual({
      NanoCpus: 1_000_000_000,
    });
  });
});

// A self-hosted BUILD stays uncapped by default — a production build routinely
// needs several GB, and it's the operator's own machine. Capping is opt-in.
describe("dockerBuildResourceLimits", () => {
  it("emits nothing when the build is uncapped (the default)", () => {
    expect(dockerBuildResourceLimits({ cpuCores: 0, memoryMb: 0, diskMb: 0 })).toEqual({});
    expect(dockerBuildResourceLimits(undefined)).toEqual({});
  });

  it("uses the /build API's field names, not the container-create ones", () => {
    const limits = dockerBuildResourceLimits({ cpuCores: 2, memoryMb: 4096 }) as Record<
      string,
      number
    >;
    expect(limits.memory).toBe(4_294_967_296);
    // /build has no NanoCpus — a CPU cap must be a quota/period pair.
    expect(limits.NanoCpus).toBeUndefined();
    expect(limits.Memory).toBeUndefined();
    expect(limits.cpuperiod).toBe(100_000);
    expect(limits.cpuquota).toBe(200_000);
  });

  it("expresses a fractional core as a sub-period quota", () => {
    expect(dockerBuildResourceLimits({ cpuCores: 0.5 })).toMatchObject({
      cpuperiod: 100_000,
      cpuquota: 50_000,
    });
  });

  it("caps memory alone without inventing a CPU quota", () => {
    expect(dockerBuildResourceLimits({ memoryMb: 8192 })).toEqual({ memory: 8_589_934_592 });
  });
});

// Adoption/migration must preserve what a container is really running with,
// including a limit an operator applied by hand with `docker update --memory`.
describe("inspectResourceLimits", () => {
  it("returns undefined for an uncapped container", () => {
    expect(inspectResourceLimits({ Memory: 0, NanoCpus: 0 })).toBeUndefined();
    expect(inspectResourceLimits({})).toBeUndefined();
    expect(inspectResourceLimits(undefined)).toBeUndefined();
  });

  it("reads a hand-applied `docker update --memory 3g`", () => {
    expect(inspectResourceLimits({ Memory: 3_221_225_472 })).toEqual({ memoryMb: 3072 });
  });

  it("reads NanoCpus", () => {
    expect(inspectResourceLimits({ NanoCpus: 1_500_000_000 })).toEqual({ cpuCores: 1.5 });
  });

  it("falls back to CpuQuota/CpuPeriod when NanoCpus is unset", () => {
    expect(inspectResourceLimits({ CpuQuota: 50_000, CpuPeriod: 100_000 })).toEqual({
      cpuCores: 0.5,
    });
  });

  it("prefers NanoCpus over the quota pair", () => {
    expect(
      inspectResourceLimits({ NanoCpus: 2_000_000_000, CpuQuota: 50_000, CpuPeriod: 100_000 }),
    ).toEqual({ cpuCores: 2 });
  });

  it("round-trips through dockerResourceLimits", () => {
    const original = { cpuCores: 1.5, memoryMb: 3072, diskMb: 0 };
    const applied = dockerResourceLimits(original);
    expect(inspectResourceLimits(applied)).toEqual({ cpuCores: 1.5, memoryMb: 3072 });
  });
});

describe("describeResourceLimits", () => {
  it("says so plainly when nothing is capped", () => {
    expect(describeResourceLimits({ cpuCores: 0, memoryMb: 0, diskMb: 0 })).toBe(
      "no limits (machine capacity)",
    );
    expect(describeResourceLimits(undefined)).toBe("no limits (machine capacity)");
  });

  it("formats each side, and only the capped ones", () => {
    expect(describeResourceLimits({ cpuCores: 2, memoryMb: 4096 })).toBe("2 vCPU · 4 GB");
    expect(describeResourceLimits({ memoryMb: 512 })).toBe("512 MB");
    expect(describeResourceLimits({ memoryMb: 1536 })).toBe("1.5 GB");
    expect(describeResourceLimits({ cpuCores: 0.5 })).toBe("0.5 vCPU");
  });
});
