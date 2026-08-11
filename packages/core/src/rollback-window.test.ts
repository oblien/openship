import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROLLBACK_WINDOW,
  MAX_ROLLBACK_WINDOW,
  MIN_AUTO_ROLLBACK_WINDOW,
  ROLLBACK_DISK_BUDGET_CAP_BYTES,
  ROLLBACK_DISK_BUDGET_FRACTION,
  computeAutoRollbackWindow,
  normalizeRollbackWindow,
} from "./rollback-window";

const GB = 1024 * 1024 * 1024;

describe("normalizeRollbackWindow", () => {
  it("passes through whole numbers in range", () => {
    expect(normalizeRollbackWindow(0)).toBe(0);
    expect(normalizeRollbackWindow(7)).toBe(7);
    expect(normalizeRollbackWindow(MAX_ROLLBACK_WINDOW)).toBe(MAX_ROLLBACK_WINDOW);
  });

  it("clamps out-of-range values instead of rejecting them", () => {
    expect(normalizeRollbackWindow(-3)).toBe(0);
    expect(normalizeRollbackWindow(999)).toBe(MAX_ROLLBACK_WINDOW);
  });

  it("truncates toward zero", () => {
    expect(normalizeRollbackWindow(4.9)).toBe(4);
    expect(normalizeRollbackWindow(-0.5)).toBe(0);
  });

  it("accepts numeric strings (query params / form values)", () => {
    expect(normalizeRollbackWindow("6")).toBe(6);
    expect(normalizeRollbackWindow("21")).toBe(MAX_ROLLBACK_WINDOW);
  });

  it("falls back for anything unusable", () => {
    for (const bad of [undefined, null, "", "abc", {}, [], true, Number.NaN, Infinity]) {
      expect(normalizeRollbackWindow(bad)).toBe(DEFAULT_ROLLBACK_WINDOW);
    }
    expect(normalizeRollbackWindow(undefined, 9)).toBe(9);
  });
});

describe("computeAutoRollbackWindow", () => {
  it("sizes the window from a fraction of free disk", () => {
    // 40 GB free · 1 GB per release → 25% budget = 10 GB → 10 releases.
    expect(computeAutoRollbackWindow({ diskFreeBytes: 40 * GB, snapshotSizeBytes: GB })).toBe(10);
    expect(ROLLBACK_DISK_BUDGET_FRACTION).toBe(0.25);
  });

  it("never claims more than the hard cap, however big the disk", () => {
    // Deliberately sized so the CAP is the only thing producing this answer.
    // 4 TB free · 2 GB per release: the 25% fraction alone would budget 1 TB
    // (512 releases → clamped to MAX = 20), so a 1 GB snapshot here would pass
    // with or without the cap. At 2 GB the cap budgets 20 GiB → 10 releases,
    // which is BELOW the product maximum — delete the cap and this fails.
    const window = computeAutoRollbackWindow({
      diskFreeBytes: 4096 * GB,
      snapshotSizeBytes: 2 * GB,
    });
    expect(ROLLBACK_DISK_BUDGET_CAP_BYTES).toBe(20 * GB);
    expect(window).toBe(10);
    expect(window).toBeLessThan(MAX_ROLLBACK_WINDOW);
  });

  it("clamps to the product maximum", () => {
    expect(
      computeAutoRollbackWindow({ diskFreeBytes: 400 * GB, snapshotSizeBytes: 64 * 1024 * 1024 }),
    ).toBe(MAX_ROLLBACK_WINDOW);
  });

  it("keeps a floor so instant rollback still exists on a cramped host", () => {
    // 2 GB free · 1.5 GB image → the budget fits zero releases, but a rollback
    // target is exactly what a nearly-full box needs most.
    expect(
      computeAutoRollbackWindow({ diskFreeBytes: 2 * GB, snapshotSizeBytes: 1.5 * GB }),
    ).toBe(MIN_AUTO_ROLLBACK_WINDOW);
  });

  it("falls back when either measurement is missing or nonsense", () => {
    const cases = [
      { diskFreeBytes: null, snapshotSizeBytes: GB },
      { diskFreeBytes: 40 * GB, snapshotSizeBytes: null },
      { diskFreeBytes: 0, snapshotSizeBytes: GB },
      { diskFreeBytes: 40 * GB, snapshotSizeBytes: 0 },
      { diskFreeBytes: Number.NaN, snapshotSizeBytes: GB },
      { diskFreeBytes: 40 * GB, snapshotSizeBytes: -1 },
      {},
    ];
    for (const input of cases) {
      expect(computeAutoRollbackWindow(input)).toBe(DEFAULT_ROLLBACK_WINDOW);
      expect(computeAutoRollbackWindow({ ...input, fallback: 3 })).toBe(3);
    }
  });

  it("normalizes the fallback too", () => {
    expect(computeAutoRollbackWindow({ fallback: 99 })).toBe(MAX_ROLLBACK_WINDOW);
  });
});
