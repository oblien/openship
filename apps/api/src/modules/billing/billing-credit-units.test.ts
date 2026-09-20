import { describe, it, expect } from "vitest";
import { PLANS, CREDIT_PACKS } from "@repo/core";
import {
  toOblienCredits,
  fromOblienCredits,
  MILLI_PER_CREDIT,
  OBLIEN_QUOTA_MAX_CREDITS,
  OBLIEN_QUOTA_MAX_MILLI,
} from "@repo/platform/engine/modules/billing/billing-credit-units";

describe("credit-unit boundary", () => {
  it("divides milli → Oblien credits (÷1000)", () => {
    expect(toOblienCredits(500_000)).toBe(500);
    expect(toOblienCredits(10_000_000)).toBe(10_000);
    expect(toOblienCredits(60_000_000)).toBe(60_000);
  });

  it("accepts exactly the ceiling", () => {
    expect(toOblienCredits(OBLIEN_QUOTA_MAX_MILLI)).toBe(OBLIEN_QUOTA_MAX_CREDITS);
  });

  it("throws above the 10,000,000-credit ceiling", () => {
    expect(() => toOblienCredits(OBLIEN_QUOTA_MAX_MILLI + MILLI_PER_CREDIT)).toThrow(
      /exceeds Oblien's/,
    );
  });

  it("throws on non-positive / non-finite amounts", () => {
    expect(() => toOblienCredits(0)).toThrow(/Invalid quota/);
    expect(() => toOblienCredits(-1000)).toThrow(/Invalid quota/);
    expect(() => toOblienCredits(Number.NaN)).toThrow(/Invalid quota/);
    expect(() => toOblienCredits(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("multiplies Oblien credits → milli (×1000)", () => {
    expect(fromOblienCredits(500)).toBe(500_000);
    expect(fromOblienCredits(97.5)).toBe(97_500);
  });

  it("round-trips", () => {
    for (const x of [500_000, 10_000_000, 60_000_000, OBLIEN_QUOTA_MAX_MILLI]) {
      expect(fromOblienCredits(toOblienCredits(x))).toBe(x);
    }
  });

  // Legacy positive allowances still fit the converter. No-plan customers get
  // zero; hosted Cloud grants now come from Oblien's catalog and paid events.
  it("every paid tier's monthlyCredits stays within the Oblien ceiling", () => {
    expect(PLANS.free.monthlyCredits).toBe(0);
    for (const plan of Object.values(PLANS)) {
      if (plan.id === "free" || plan.monthlyCredits === null) continue;
      expect(() => toOblienCredits(plan.monthlyCredits as number)).not.toThrow();
      expect(toOblienCredits(plan.monthlyCredits as number)).toBeLessThanOrEqual(
        OBLIEN_QUOTA_MAX_CREDITS,
      );
    }
  });

  it("every credit pack converts within the ceiling", () => {
    for (const pack of CREDIT_PACKS) {
      expect(() => toOblienCredits(pack.credits_milli)).not.toThrow();
      expect(toOblienCredits(pack.credits_milli)).toBeLessThanOrEqual(
        OBLIEN_QUOTA_MAX_CREDITS,
      );
    }
  });
});
