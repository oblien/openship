import { describe, expect, it } from "vitest";

import {
  decodeResources,
  encodeResources,
  resolveBuildResources,
  resolveRuntimeResources,
  withDefaults,
} from "@repo/platform/engine/lib/resources";
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
    expect(resolveRuntimeResources(null)).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
    expect(resolveRuntimeResources(undefined).memoryMb).not.toBe(512);
  });

  it("gives managed-server containers the same full-capacity default", () => {
    expect(resolveRuntimeResources(null)).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
  });

  it("honors a configured value on either target", () => {
    const configured = { cpuCores: 3, memoryMb: 3072, diskMb: 5120 };
    expect(resolveRuntimeResources(configured)).toEqual(configured);
    expect(resolveRuntimeResources(configured)).toEqual(configured);
  });

  it("preserves an explicit 0 on self-hosted (0 is a choice, not 'unset')", () => {
    expect(
      resolveRuntimeResources({ cpuCores: 0, memoryMb: 0, diskMb: 0 }),
    ).toEqual({ cpuCores: 0, memoryMb: 0, diskMb: 0 });
  });

  // Container limits are independent of the server's purchased allocation.
  it("preserves unlimited when a project moves to a managed server", () => {
    expect(
      resolveRuntimeResources({ cpuCores: 0, memoryMb: 0, diskMb: 0 }),
    ).toEqual({ cpuCores: 0, memoryMb: 0, diskMb: 0 });
  });

  it("keeps the legacy { cpus } / { cpuConfig } shapes readable", () => {
    expect(resolveRuntimeResources({ cpus: 2, memoryMb: 1024 }).cpuCores).toBe(2);
    expect(
      resolveRuntimeResources(
        { cpuConfig: { quotaUs: 50_000, periodUs: 100_000 }, memoryMb: 1024 },
      ).cpuCores,
    ).toBe(0.5);
  });
});

describe("resolveBuildResources", () => {
  it("lets a self-hosted build use the whole machine", () => {
    expect(resolveBuildResources(null)).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
    });
  });

  it("leaves managed build limits automatic until live headroom is measured", () => {
    expect(resolveBuildResources(null)).toEqual({
      cpuCores: 0,
      memoryMb: 0,
      diskMb: 0,
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

  it("preserves Micro without rounding a quarter CPU to a whole core", () => {
    expect(decodeResources({ cpuCores: 0.25, memoryMb: 256 })).toEqual({ cpuCores: 0.25, memoryMb: 256, diskMb: 0 });
  });

  it("rejects negatives outright", () => {
    expect(() => decodeResources({ memoryMb: -1 })).toThrow(/non-negative/);
  });

  it("rejects a cap below the workable floor", () => {
    expect(() => decodeResources({ memoryMb: 64 }, { capacity: box64 })).toThrow(/at least 128 MB/);
  });
});

describe("encodeResources", () => {
  it("reports automatic hosted Cloud builds without inventing a fixed CPU/RAM machine", () => {
    expect(encodeResources(null, null, "auto_sleep", 3000, { automaticBuild: true }))
      .toMatchObject({ buildMode: "automatic", build: { cpuCores: 0, memoryMb: 0, diskMb: 0 } });
    const build = { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 };
    expect(encodeResources(null, build, "auto_sleep", 3000, { automaticBuild: true }))
      .toMatchObject({ buildMode: "custom", build });
  });
  it("reports unlimited + the detected tier for an unconfigured self-hosted project", () => {
    const out = encodeResources(null, null, "auto_sleep", 3000, {
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
    const out = encodeResources(null, null, "auto_sleep", 3000);
    expect(out).not.toHaveProperty("capacity");
    expect(out.tier).toBe("unlimited");
  });

  it("reports full capacity without a required container limit on managed servers", () => {
    const out = encodeResources(null, null, "auto_sleep", 3000);
    expect(out.production).toMatchObject({ memoryMb: 0 });
    expect(out.tier).toBe("unlimited");
    expect(out.requiresLimit).toBe(false);
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
