import { describe, expect, it } from "vitest";
import { billingUsageWindow, formatBillingNumber, formatMilliCredits, usageTimestamp, weeklyCreditUsage } from "./billing-usage";

describe("Cloud usage units and dates", () => {
  it("formats balances and provider usage in the same customer unit without shrinking usage 1000x", () => {
    expect(formatMilliCredits(125_500, "en")).toBe("125.5");
    expect(formatBillingNumber(125.5, "en")).toBe("125.5");
    expect(formatMilliCredits(-1_500, "en")).toBe("-1.5");
    expect(formatMilliCredits(null, "en")).toBe("—");
    expect(formatMilliCredits(undefined, "en")).toBe("—");
  });
  const now = new Date("2026-09-18T12:30:00Z");
  it("includes today's usage up to now, without requesting the future subscription end", () => {
    expect(billingUsageWindow("2026-09-01", "2026-09-18", now)).toEqual({ from: "2026-09-01T00:00:00.000Z", to: now.toISOString() });
    expect(billingUsageWindow("2026-09-01", "2027-09-01", now)?.to).toBe(now.toISOString());
  });
  it("includes the entire selected final day, even for a single-day range", () => {
    expect(billingUsageWindow("2026-09-17", "2026-09-17", now)).toEqual({ from: "2026-09-17T00:00:00.000Z", to: "2026-09-17T23:59:59.999Z" });
  });
  it.each([["", "2026-09-18"], ["2026-09-18", "2026-09-17"], ["2026-09-19", "2026-09-20"], ["2026-02-30", "2026-09-18"]])("rejects invalid dates %s – %s", (from, to) => {
    expect(billingUsageWindow(from, to, now)).toBeNull();
  });
  it("uses UTC for provider timestamps and keeps Sunday and Monday in separate weeks", () => {
    expect(usageTimestamp("2026-09-13 23:30:00").toISOString()).toBe("2026-09-13T23:30:00.000Z");
    expect(weeklyCreditUsage([
      { timestamp: "2026-09-14 00:00:00", credits: 120.25 },
      { timestamp: "2026-09-13 23:30:00", credits: 10 },
      { timestamp: "2026-09-15T00:00:00Z", credits: 30.5 },
    ])).toEqual([
      { timestamp: "2026-09-07T00:00:00.000Z", credits: 10 },
      { timestamp: "2026-09-14T00:00:00.000Z", credits: 150.75 },
    ]);
  });
});
