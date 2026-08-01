import { describe, expect, it } from "vitest";

import {
  RESOURCE_TIER_SPECS,
  UNLIMITED_RESOURCES,
  UNKNOWN_CAPACITY,
  detectTier,
  formatCpuCores,
  formatMemoryMb,
  hasCpuLimit,
  hasMemoryLimit,
  isUnlimited,
  resolveTierResources,
  validateAgainstCapacity,
  type HostCapacity,
} from "./resources";

const box64 = (): HostCapacity => ({ cpuCores: 16, memoryMb: 65536, source: "docker" });
const tinyBox = (): HostCapacity => ({ cpuCores: 2, memoryMb: 2048, source: "docker" });

describe("limit predicates (0 = no limit)", () => {
  it("treats 0 and absent as uncapped", () => {
    expect(hasMemoryLimit({ memoryMb: 0 })).toBe(false);
    expect(hasMemoryLimit({})).toBe(false);
    expect(hasMemoryLimit(undefined)).toBe(false);
    expect(hasCpuLimit({ cpuCores: 0 })).toBe(false);
    expect(isUnlimited(UNLIMITED_RESOURCES)).toBe(true);
  });

  it("treats any positive value as capped", () => {
    expect(hasMemoryLimit({ memoryMb: 128 })).toBe(true);
    expect(hasCpuLimit({ cpuCores: 0.25 })).toBe(true);
    expect(isUnlimited({ cpuCores: 0, memoryMb: 512 })).toBe(false);
  });
});

describe("resolveTierResources", () => {
  it("maps the Oblien presets to their specs", () => {
    expect(resolveTierResources("low")).toEqual(RESOURCE_TIER_SPECS.low);
    expect(resolveTierResources("high")).toEqual(RESOURCE_TIER_SPECS.high);
  });

  it("resolves unlimited to all-zero", () => {
    expect(resolveTierResources("unlimited")).toEqual(UNLIMITED_RESOURCES);
  });

  // The original bug: an unusable "custom" selection fell back to 512 MB. The
  // caller explicitly opted OUT of the presets, so unlimited is the honest
  // answer — never a silent tier.
  it("falls back to unlimited (never a tier) for an empty custom selection", () => {
    expect(resolveTierResources("custom")).toEqual(UNLIMITED_RESOURCES);
    expect(resolveTierResources("custom", {})).toEqual(UNLIMITED_RESOURCES);
    expect(resolveTierResources("custom", { cpuCores: 0, memoryMb: 0 })).toEqual(
      UNLIMITED_RESOURCES,
    );
    expect(resolveTierResources("custom", null).memoryMb).not.toBe(512);
  });

  it("passes custom values through, including large ones", () => {
    expect(resolveTierResources("custom", { cpuCores: 8, memoryMb: 32768, diskMb: 0 })).toEqual({
      cpuCores: 8,
      memoryMb: 32768,
      diskMb: 0,
    });
  });

  it("keeps a one-sided custom cap one-sided", () => {
    expect(resolveTierResources("custom", { memoryMb: 4096 })).toEqual({
      cpuCores: 0,
      memoryMb: 4096,
      diskMb: 0,
    });
  });
});

describe("detectTier", () => {
  it("recognizes an unset/zero config as unlimited", () => {
    expect(detectTier(null)).toBe("unlimited");
    expect(detectTier(UNLIMITED_RESOURCES)).toBe("unlimited");
  });

  it("recognizes preset specs by cpu+memory", () => {
    expect(detectTier(RESOURCE_TIER_SPECS.medium)).toBe("medium");
    expect(detectTier({ cpuCores: 0.5, memoryMb: 512, diskMb: 99 })).toBe("low");
  });

  it("falls through to custom for anything else", () => {
    expect(detectTier({ cpuCores: 3, memoryMb: 3072, diskMb: 0 })).toBe("custom");
  });
});

describe("validateAgainstCapacity", () => {
  it("accepts a value the machine can back", () => {
    expect(
      validateAgainstCapacity({ cpuCores: 3, memoryMb: 3072, diskMb: 0 }, box64()),
    ).toBeNull();
  });

  // The old flat ceiling (4 cores / 8192 MB) made this impossible to request.
  it("accepts far more than the old hardcoded 8 GB ceiling on a big box", () => {
    expect(
      validateAgainstCapacity({ cpuCores: 12, memoryMb: 32768, diskMb: 0 }, box64()),
    ).toBeNull();
  });

  it("rejects a value the machine cannot back", () => {
    expect(validateAgainstCapacity({ cpuCores: 1, memoryMb: 8192, diskMb: 0 }, tinyBox()))
      .toMatch(/exceeds the machine's 2048 MB/);
    expect(validateAgainstCapacity({ cpuCores: 8, memoryMb: 512, diskMb: 0 }, tinyBox()))
      .toMatch(/exceeds the machine's 2 cores/);
  });

  it("always accepts unlimited, on any machine", () => {
    expect(validateAgainstCapacity(UNLIMITED_RESOURCES, tinyBox())).toBeNull();
    expect(validateAgainstCapacity(UNLIMITED_RESOURCES, UNKNOWN_CAPACITY)).toBeNull();
  });

  it("enforces no ceiling when the probe failed, rather than blocking the save", () => {
    expect(
      validateAgainstCapacity({ cpuCores: 64, memoryMb: 262144, diskMb: 0 }, UNKNOWN_CAPACITY),
    ).toBeNull();
  });

  it("still rejects a cap below the workable floor", () => {
    expect(validateAgainstCapacity({ cpuCores: 0.1, memoryMb: 0, diskMb: 0 }, box64())).toMatch(
      /at least 0.25 cores/,
    );
    expect(validateAgainstCapacity({ cpuCores: 0, memoryMb: 64, diskMb: 0 }, box64())).toMatch(
      /at least 128 MB/,
    );
  });
});

describe("formatters", () => {
  it("renders uncapped as 'no limit'", () => {
    expect(formatMemoryMb(0)).toBe("no limit");
    expect(formatCpuCores(0)).toBe("no limit");
  });

  it("renders MB/GB and vCPU", () => {
    expect(formatMemoryMb(512)).toBe("512 MB");
    expect(formatMemoryMb(2048)).toBe("2 GB");
    expect(formatMemoryMb(1536)).toBe("1.5 GB");
    expect(formatCpuCores(0.5)).toBe("0.5 vCPU");
  });
});
