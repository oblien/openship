import { describe, expect, it } from "vitest";
import { buildTrafficSeries } from "./traffic-series";

const hour = 3_600_000;
const start = Date.parse("2026-09-24T23:00:00Z");
const period = (offset: number, requests: number) => ({
  from: new Date(start + offset * hour).toISOString(),
  to: new Date(start + (offset + 1) * hour).toISOString(),
  requests,
});

describe("traffic chart intervals", () => {
  it("positions counts inside their actual hours, including across midnight", () => {
    const points = buildTrafficSeries([period(1, 20), period(0, 10)]);
    expect(points.map((point) => point.timestamp)).toEqual([start + hour / 2, start + 1.5 * hour]);
    expect(points.map((point) => point.requests)).toEqual([10, 20]);
  });

  it("keeps a missing interval empty instead of drawing zero traffic or connecting across it", () => {
    const points = buildTrafficSeries([period(0, 10), period(3, 20)]);
    expect(points).toHaveLength(3);
    expect(points[1]).toEqual({ from: start + hour, to: start + 3 * hour, timestamp: start + 2 * hour, requests: null });
    expect(points.reduce((sum, point) => sum + (point.requests ?? 0), 0)).toBe(30);
  });

  it("does not turn one real bucket into a fabricated full-width series", () => {
    const points = buildTrafficSeries([period(0, 9)]);
    expect(points).toHaveLength(1);
    expect(points[0].timestamp).toBe((points[0].from + points[0].to) / 2);
    expect(buildTrafficSeries([])).toEqual([]);
  });

  it("keeps measured zeroes and rejects malformed intervals instead of drawing NaN", () => {
    const points = buildTrafficSeries([
      period(0, 0), { ...period(1, 1), to: "invalid" },
      { ...period(2, 2), from: period(2, 2).to }, period(3, NaN),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].requests).toBe(0);
  });
});
