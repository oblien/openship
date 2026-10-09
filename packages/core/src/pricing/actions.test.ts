import { describe, expect, it } from "vitest";
import { PRICING } from "./index";
import { actionDepositUnits, actionCreditUnits, ACTIONS_UNITS_PER_CENT } from "./actions";

describe("prepaid Actions usage", () => {
  it("keeps deposits and bounded runner sizes separate from app-server plans", () => {
    expect(PRICING.actions.depositsCents).toEqual([500, 2000, 5000, 10000]);
    expect(PRICING.actions.maxParallel).toBe(2);
    expect(PRICING.actions.runners.map((r) => [r.cpuCores, r.memoryMb, r.diskGb])).toEqual([
      [2, 4096, 40],
      [4, 8192, 80],
      [8, 16384, 160],
    ]);
  });
  it("preserves provider fractional credits without introducing per-job rounding", () => {
    expect(actionCreditUnits(500)).toBe(actionDepositUnits(500));
    expect(actionCreditUnits(0.15)).toBe(90_000);
    expect(actionCreditUnits(0.0000001)).toBe(0);
    expect(actionCreditUnits(100) / ACTIONS_UNITS_PER_CENT / 100).toBe(1);
  });
  it("rejects invalid amounts instead of inventing credit", () => {
    for (const value of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => actionDepositUnits(value)).toThrow();
      expect(() => actionCreditUnits(value)).toThrow();
    }
    expect(() => actionDepositUnits(0.5)).toThrow();
  });
});
