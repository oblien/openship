import { describe, expect, it } from "vitest";
import { PRICING } from "./index";
import {
  actionAffordableSeconds,
  actionDepositUnits,
  actionExecutionUnits,
  ACTIONS_UNITS_PER_CENT,
} from "./actions";

describe("approved prepaid Actions prices", () => {
  it("publishes the approved resources and prices independently of app-server plans", () => {
    expect(PRICING.actions.depositsCents).toEqual([500, 2000, 5000, 10000]);
    expect(PRICING.actions.transferGiBPerDollar).toBe(5);
    expect(
      PRICING.actions.runners.map((r) => [r.cpuCores, r.memoryMb, r.diskGb, r.microUsdPerMinute]),
    ).toEqual([
      [2, 4096, 40, 4000],
      [4, 8192, 80, 8000],
      [8, 16384, 160, 16000],
    ]);
  });
  it("preserves fractional cents across short and long jobs", () => {
    const runner = PRICING.actions.runners[0]!;
    expect(actionExecutionUnits(runner, 60) / ACTIONS_UNITS_PER_CENT).toBe(0.4);
    expect(actionExecutionUnits(runner, 3600) / ACTIONS_UNITS_PER_CENT).toBe(24);
    expect(
      Array.from({ length: 60 }, () => actionExecutionUnits(runner, 1)).reduce((a, b) => a + b, 0),
    ).toBe(actionExecutionUnits(runner, 60));
    expect(actionExecutionUnits(runner, 0)).toBe(0);
  });
  it("reserves only affordable execution seconds and rejects malformed money", () => {
    const runner = PRICING.actions.runners[2]!;
    const available = actionDepositUnits(500);
    const seconds = actionAffordableSeconds(runner, available, 21_600);
    expect(seconds).toBe(18_750);
    expect(actionExecutionUnits(runner, seconds)).toBe(available);
    expect(actionAffordableSeconds(runner, 15_999, 60)).toBe(0);
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => actionDepositUnits(value)).toThrow();
      expect(() => actionExecutionUnits(runner, value)).toThrow();
    }
  });
});
