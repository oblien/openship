import { describe, expect, it } from "vitest";

import {
  decodeResources,
  encodeResources,
  resolveBuildResources,
  resolveRuntimeResources,
  withDefaults,
} from "../../src/lib/resources";
import type { HostCapacity } from "@repo/core";

const box64: HostCapacity = { cpuCores: 16, memoryMb: 65536, source: "docker" };
const tinyBox: HostCapacity = { cpuCores: 2, memoryMb: 2048, source: "docker" };
const unknown: HostCapacity = { cpuCores: 0, memoryMb: 0, source: "unknown" };

/**
 * #333: every self-hosted container was created at 512 MB because the CLOUD
 * free tier was used as the fallback on both targets. The split below is the fix.
 */
describe("resolveRuntimeResources", () => {
  it("gives a self-hosted project NO limits when nothing is configured", () => {
    expect(resolveRuntimeResources(null, { isCloud: false })).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
    expect(resolveRuntimeResources(undefined, { isCloud: false }).memoryMb).not.toBe(512);
  });

  it("still gives a cloud project the metered free tier when nothing is configured", () => {
    expect(resolveRuntimeResources(null, { isCloud: true })).toEqual({
      cpuCores: 0.5,
      memoryMb: 512,
      diskMb: 5120,
    });
  });

  it("honors a configured value on either target", () => {
    const configured = { cpuCores: 3, memoryMb: 3072, diskMb: 5120 };
    expect(resolveRuntimeResources(configured, { isCloud: false })).toEqual(configured);
    expect(resolveRuntimeResources(configured, { isCloud: true })).toEqual(configured);
  });

  it("preserves an explicit 0 on self-hosted (0 is a choice, not 'unset')", () => {
    expect(
      resolveRuntimeResources({ cpuCores: 0, memoryMb: 0, diskMb: 0 }, { isCloud: false }),
    ).toEqual({ cpuCores: 0, memoryMb: 0, diskMb: 0 });
  });

  // A project set to unlimited while self-hosted and LATER promoted to cloud
  // would otherwise reach Oblien as `memory_mb: 0` and fail to provision.
  it("coerces unlimited to a concrete tier when the target is cloud", () => {
    expect(
      resolveRuntimeResources({ cpuCores: 0, memoryMb: 0, diskMb: 0 }, { isCloud: true }),
    ).toEqual({ cpuCores: 0.5, memoryMb: 512, diskMb: 5120 });
  });

  it("keeps the legacy { cpus } / { cpuConfig } shapes readable", () => {
    expect(resolveRuntimeResources({ cpus: 2, memoryMb: 1024 }, { isCloud: false }).cpuCores).toBe(2);
    expect(
      resolveRuntimeResources(
        { cpuConfig: { quotaUs: 50_000, periodUs: 100_000 }, memoryMb: 1024 },
        { isCloud: false },
      ).cpuCores,
    ).toBe(0.5);
  });
});

describe("resolveBuildResources", () => {
  it("lets a self-hosted build use the whole machine", () => {
    expect(resolveBuildResources(null, { isCloud: false })).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
  });

  it("keeps the build-sized default on cloud", () => {
    expect(resolveBuildResources(null, { isCloud: true })).toEqual({
      cpuCores: 4,
      memoryMb: 8192,
      diskMb: 10240,
    });
  });
});

describe("decodeResources", () => {
  it("accepts 0 as 'no limit' for self-hosted", () => {
    expect(decodeResources({ cpuCores: 0, memoryMb: 0, diskMb: 0 })).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
  });

  // The old flat ceiling made this impossible — the whole point of the fix.
  it("accepts far more than the old 4-core / 8192 MB ceiling on a big box", () => {
    expect(decodeResources({ cpuCores: 12, memoryMb: 32768 }, { capacity: box64 })).toMatchObject({
      cpuCores: 12,
      memoryMb: 32768,
    });
  });

  it("rejects a value the target machine cannot back", () => {
    expect(() => decodeResources({ memoryMb: 8192 }, { capacity: tinyBox })).toThrow(
      /exceeds the machine's 2048 MB/,
    );
    expect(() => decodeResources({ cpuCores: 8 }, { capacity: tinyBox })).toThrow(
      /exceeds the machine's 2 cores/,
    );
  });

  it("enforces no ceiling when the capacity probe failed", () => {
    expect(
      decodeResources({ cpuCores: 64, memoryMb: 262144 }, { capacity: unknown }),
    ).toMatchObject({ cpuCores: 64, memoryMb: 262144 });
  });

  it("requires an explicit limit when the target is cloud", () => {
    expect(() =>
      decodeResources({ cpuCores: 0, memoryMb: 0 }, { requireLimit: true }),
    ).toThrow(/requires explicit CPU and memory limits/);
  });

  it("rejects negatives outright", () => {
    expect(() => decodeResources({ memoryMb: -1 })).toThrow(/cannot be negative/);
  });

  it("rejects a cap below the workable floor", () => {
    expect(() => decodeResources({ memoryMb: 64 }, { capacity: box64 })).toThrow(/at least 128 MB/);
  });
});

describe("encodeResources", () => {
  it("reports unlimited + the detected tier for an unconfigured self-hosted project", () => {
    const out = encodeResources(null, null, "auto_sleep", 3000, {
      isCloud: false,
      capacity: box64,
    });
    expect(out.production).toEqual({ cpuCores: 0, memoryMb: 0, diskMb: 0 });
    expect(out.tier).toBe("unlimited");
    expect(out.requiresLimit).toBe(false);
    expect(out.capacity).toEqual(box64);
  });

  // The project list/info encodes hundreds of rows and must not carry a
  // meaningless capacity blob (or imply one was probed) — absent ≠ "unknown".
  it("omits capacity entirely when none was probed", () => {
    const out = encodeResources(null, null, "auto_sleep", 3000, { isCloud: false });
    expect(out).not.toHaveProperty("capacity");
    expect(out.tier).toBe("unlimited");
  });

  it("reports the free tier and requiresLimit for an unconfigured cloud project", () => {
    const out = encodeResources(null, null, "auto_sleep", 3000, { isCloud: true });
    expect(out.production).toMatchObject({ memoryMb: 512 });
    expect(out.tier).toBe("low");
    expect(out.requiresLimit).toBe(true);
  });

  it("labels a saved preset by name and anything else as custom", () => {
    expect(
      encodeResources({ cpuCores: 1, memoryMb: 1024, diskMb: 16384 }, null).tier,
    ).toBe("medium");
    expect(encodeResources({ cpuCores: 3, memoryMb: 3072, diskMb: 0 }, null).tier).toBe("custom");
  });
});

describe("withDefaults", () => {
  it("does not treat an explicit 0 as unset", () => {
    expect(withDefaults({ cpuCores: 0, memoryMb: 0, diskMb: 0 })).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
  });
});
