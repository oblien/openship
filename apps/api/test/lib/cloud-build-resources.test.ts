import { describe, expect, it } from "vitest";
import {
  decideCloudBuildResources,
  type CloudBuildReservation,
  type CloudBuildResourceInput,
} from "@repo/platform/engine/lib/cloud-build-resources";

const capacity = { cpuCores: 4, memoryMb: 8192 };
const usage = { available: true, memoryAvailableMb: 8192, cpuPercent: 0 };
const decide = (patch: Partial<CloudBuildResourceInput> = {}) =>
  decideCloudBuildResources({ capacity, usage, reservations: [], ...patch });

describe("Cloud build resource admission", () => {
  it.each([undefined, null, {}, { cpuCores: 0, memoryMb: 0 }])(
    "leaves automatic settings %j uncapped without reserving the host",
    (requested) => {
      expect(decide({ requested })).toEqual({
        kind: "admit",
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
      });
      expect(
        decide({
          requested,
          capacity: { cpuCores: 64, memoryMb: 131072 },
          usage: { ...usage, memoryAvailableMb: 131072 },
        }),
      ).toEqual({ kind: "admit", resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 } });
    },
  );

  it.each([
    [256, 128],
    [2048, 1920],
    [8192, 7782],
    [32768, 32256],
  ])("leaves system headroom on a %i MB server", (memoryMb, budget) => {
    const patch = {
      capacity: { ...capacity, memoryMb },
      usage: { ...usage, memoryAvailableMb: memoryMb },
    };
    expect(decide({ ...patch, requested: { memoryMb: budget } })).toMatchObject({ kind: "admit", resources: { memoryMb: budget } });
    expect(decide({ ...patch, requested: { memoryMb: budget + 1 } })).toEqual({
      kind: "impossible",
      reason: "memory-exceeds-capacity",
    });
  });

  it("does not freeze sampled idle CPU or available RAM into an automatic budget", () => {
    expect(decide({ usage: { ...usage, memoryAvailableMb: 5000, cpuPercent: 75 } })).toEqual(
      decide(),
    );
    expect(decide({ usage: null })).toEqual(decide());
    expect(decide({ reservations: [{ cpuCores: 0.25, memoryMb: 128 }] })).toEqual(decide());
  });
  it("leaves unspecified dimensions uncapped and keeps explicit caps unchanged", () => {
    expect(decide({ requested: { memoryMb: 512 } })).toMatchObject({
      kind: "admit",
      resources: { cpuCores: 0, memoryMb: 512 },
    });
    expect(decide({ requested: { cpuCores: 1 } })).toMatchObject({
      kind: "admit",
      resources: { cpuCores: 1, memoryMb: 0 },
    });
    expect(
      decide({
        requested: { cpuCores: 1, memoryMb: 512 },
        reservations: [{ cpuCores: 1, memoryMb: 512 }],
      }),
    ).toMatchObject({ kind: "admit", resources: { cpuCores: 1, memoryMb: 512 } });
  });

  it("does not allocate beyond physical capacity when a sample overstates available RAM", () => {
    expect(decide({ requested: { memoryMb: 7782 }, usage: { ...usage, memoryAvailableMb: 999999 } })).toMatchObject({
      kind: "admit",
      resources: { memoryMb: 7782 },
    });
  });

  it("admits an uncapped sibling without inventing CPU or memory reservations", () => {
    expect(
      decide({
        usage: { ...usage, cpuPercent: 75 },
        reservations: [{ cpuCores: 1, memoryMb: 128 }],
      }),
    ).toEqual({ kind: "admit", resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 } });
  });
  it.each([0.25, 1])(
    "keeps an uncapped worker shared on a %s-vCPU server",
    (cpuCores) => {
      expect(
        decide({
          capacity: { cpuCores, memoryMb: 8192 },
          usage: { ...usage, cpuPercent: 80 },
        }),
      ).toEqual({ kind: "admit", resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 } });
    },
  );

  it.each([undefined, null, 1, 4, 8, 20])(
    "treats plan concurrency %s as a ceiling, not a resource partition",
    (concurrencyLimit) => {
      expect(decide({ concurrencyLimit })).toEqual(decide());
    },
  );

  it.each([
    [
      { cpuCores: 2.3, memoryMb: 3000 },
      { cpuCores: 2.3, memoryMb: 3000, diskMb: 0 },
    ],
    [{ cpuCores: 0.3 }, { cpuCores: 0.3, memoryMb: 0, diskMb: 0 }],
    [{ memoryMb: 256 }, { cpuCores: 0, memoryMb: 256, diskMb: 0 }],
  ])(
    "reserves only explicitly limited dimensions: %j",
    (requested, resources) => {
      expect(decide({ requested })).toEqual({ kind: "admit", resources });
    },
  );

  it("waits for an explicit allocation instead of shrinking it under memory pressure", () => {
    const patch = { usage: { ...usage, memoryAvailableMb: 1024 } };
    expect(decide(patch)).toMatchObject({ kind: "admit", resources: { memoryMb: 0 } });
    expect(decide({ ...patch, requested: { memoryMb: 1024 } })).toEqual({
      kind: "wait",
      reason: "memory-pressure",
    });
    expect(decide({ requested: { memoryMb: 1024 } }).kind).toBe("admit");
  });

  it("admits concurrent automatic builds while keeping their slots distinct", () => {
    const first = decide();
    expect(first.kind).toBe("admit");
    if (first.kind !== "admit") throw new Error("Expected admission");
    expect(decide({ reservations: [first.resources] })).toEqual(first);
    expect(decide()).toEqual(first);
  });

  it("admits concurrent explicit allocations without over-reserving before workers start", () => {
    const reservations: CloudBuildReservation[] = [];
    const patch = { reservations, requested: { cpuCores: 1, memoryMb: 1024 } };
    for (let i = 0; i < 4; i++) {
      const result = decide(patch);
      expect(result).toEqual({
        kind: "admit",
        resources: { cpuCores: 1, memoryMb: 1024, diskMb: 0 },
      });
      if (result.kind !== "admit") throw new Error("Expected admission");
      reservations.push(result.resources);
    }
    expect(decide(patch)).toEqual({ kind: "wait", reason: "cpu-pressure" });
    reservations.pop();
    expect(decide(patch).kind).toBe("admit");
  });

  it("preserves fractional capacity without rounding up past the server or reservations", () => {
    expect(
      decide({
        capacity: { cpuCores: 0.3, memoryMb: 256 },
        usage: { ...usage, memoryAvailableMb: 256 },
      }),
    ).toEqual({
      kind: "admit",
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    });
    const reservations: CloudBuildReservation[] = [];
    const patch = {
      capacity: { cpuCores: 8, memoryMb: 32768 },
      usage: { ...usage, memoryAvailableMb: 32768 },
      reservations,
      requested: { cpuCores: 0.4, memoryMb: 512 },
      concurrencyLimit: 20,
    };
    for (let i = 0; i < 20; i++) {
      const result = decide(patch);
      expect(result.kind).toBe("admit");
      if (result.kind !== "admit") throw new Error("Expected admission");
      reservations.push(result.resources);
    }
    expect(decide(patch)).toEqual({ kind: "wait", reason: "cpu-pressure" });
  });

  it("counts full reservations when admitting explicitly limited siblings", () => {
    expect(
      decide({
        requested: { cpuCores: 1, memoryMb: 512 },
        usage: { ...usage, memoryAvailableMb: 4096 },
        reservations: [{ cpuCores: 1, memoryMb: 3000 }],
      }),
    ).toMatchObject({ kind: "admit", resources: { memoryMb: 512 } });
    expect(
      decide({
        requested: { cpuCores: 1, memoryMb: 512 },
        usage: { ...usage, memoryAvailableMb: 4096 },
        reservations: [{ cpuCores: 1, memoryMb: 3600 }],
      }),
    ).toEqual({ kind: "wait", reason: "memory-pressure" });
  });

  it.each([95, 99, 100])(
    "waits under extreme CPU pressure for explicitly limited builds (%s%%)",
    (cpuPercent) => {
      for (const requested of [{ cpuCores: 0.25, memoryMb: 512 }]) {
        expect(decide({ usage: { ...usage, cpuPercent }, requested })).toEqual({
          kind: "wait",
          reason: "cpu-pressure",
        });
      }
    },
  );

  it("waits below the minimum free memory and resumes when it becomes available", () => {
    expect(
      decide({ requested: { memoryMb: 128 }, usage: { ...usage, memoryAvailableMb: 537 } }),
    ).toEqual({
      kind: "wait",
      reason: "memory-pressure",
    });
    expect(
      decide({ requested: { memoryMb: 128 }, usage: { ...usage, memoryAvailableMb: 538 } }),
    ).toMatchObject({
      kind: "admit",
      resources: { memoryMb: 128 },
    });
  });

  it.each([NaN, Infinity, -Infinity, -1])("rejects malformed requested resources: %s", (value) => {
    for (const requested of [{ cpuCores: value }, { memoryMb: value }]) {
      expect(decide({ requested })).toEqual({ kind: "impossible", reason: "invalid-request" });
    }
  });
  it.each([{ cpuCores: 0.1 }, { memoryMb: 127 }])(
    "rejects requested resources below the minimum: %j",
    (requested) => {
      expect(decide({ requested })).toEqual({ kind: "impossible", reason: "invalid-request" });
    },
  );
  it.each([
    [{ cpuCores: 5 }, "cpu-exceeds-capacity"],
    [{ memoryMb: 8192 }, "memory-exceeds-capacity"],
  ])("recognizes impossible requests without a live sample: %j", (requested, reason) => {
    expect(decide({ usage: null, requested })).toEqual({ kind: "impossible", reason });
  });
  it.each([
    [{ cpuCores: 0.2, memoryMb: 8192 }, "cpu-exceeds-capacity"],
    [{ cpuCores: 4, memoryMb: 255 }, "memory-exceeds-capacity"],
  ])("rejects servers below the minimum: %j", (capacity, reason) => {
    expect(decide({ capacity })).toEqual({ kind: "impossible", reason });
  });
  it.each([0, -1, NaN, Infinity])("waits for usable physical capacity: %s", (value) => {
    for (const capacityPatch of [
      { ...capacity, cpuCores: value },
      { ...capacity, memoryMb: value },
    ]) {
      expect(decide({ capacity: capacityPatch })).toEqual({
        kind: "wait",
        reason: "capacity-unavailable",
      });
    }
  });
  it.each([
    null,
    { ...usage, available: false },
    { ...usage, memoryAvailableMb: null },
    { ...usage, cpuPercent: null },
    ...[NaN, Infinity, -1].flatMap((value) => [
      { ...usage, memoryAvailableMb: value },
      { ...usage, cpuPercent: value },
    ]),
    { ...usage, cpuPercent: 101 },
  ])("waits on unknown or malformed observations: %j", (usage) => {
    expect(decide({ requested: { cpuCores: 1, memoryMb: 512 }, usage })).toEqual({
      kind: "wait",
      reason: "usage-unavailable",
    });
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "waits on an invalid concurrency ceiling: %s",
    (concurrencyLimit) => {
      expect(decide({ concurrencyLimit })).toEqual({
        kind: "wait",
        reason: "concurrency-unavailable",
      });
    },
  );
  it.each([-1, NaN, Infinity])("fails closed on malformed reservations: %s", (value) => {
    for (const reservation of [
      { cpuCores: value, memoryMb: 128 },
      { cpuCores: 1, memoryMb: value },
    ]) {
      expect(decide({ reservations: [reservation] })).toEqual({
        kind: "wait",
        reason: "reservations-unavailable",
      });
    }
  });
  it("fails closed on overflowing reservations", () => {
    expect(
      decide({
        reservations: [
          { cpuCores: 1, memoryMb: Number.MAX_VALUE },
          { cpuCores: 1, memoryMb: Number.MAX_VALUE },
        ],
      }),
    ).toEqual({
      kind: "wait",
      reason: "reservations-unavailable",
    });
  });
  it("waits when a host resize leaves less capacity than existing reservations", () => {
    expect(decide({ requested: { cpuCores: 0.25, memoryMb: 128 }, reservations: [{ cpuCores: 8, memoryMb: 16384 }] })).toEqual({
      kind: "wait",
      reason: "memory-pressure",
    });
    expect(
      decide({ requested: { cpuCores: 0.25, memoryMb: 128 }, reservations: [{ cpuCores: 8, memoryMb: 128 }] }),
    ).toEqual({
      kind: "wait",
      reason: "cpu-pressure",
    });
  });
  it("does not mutate frozen input or its reservation ledger", () => {
    const input = Object.freeze({
      capacity: Object.freeze(capacity),
      usage: Object.freeze(usage),
      requested: Object.freeze({ cpuCores: 2, memoryMb: 2048 }),
      reservations: Object.freeze([Object.freeze({ cpuCores: 1, memoryMb: 1024 })]),
    });
    const before = structuredClone(input);
    expect(decideCloudBuildResources(input)).toEqual(decideCloudBuildResources(input));
    expect(input).toEqual(before);
  });
});
