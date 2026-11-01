import { describe, expect, it } from "vitest";
import {
  summariseBuckets,
  buildHourlyPeriods,
} from "@repo/platform/engine/modules/analytics/analytics.service";

interface Bucket {
  minute: number;
  requests: number;
  unique_requests: number;
  bandwidth_in: number;
  bandwidth_out: number;
  response_time: number;
}

function bucket(minute: number, requests: number, responseTime: number): Bucket {
  return {
    minute,
    requests,
    unique_requests: requests,
    bandwidth_in: 0,
    bandwidth_out: 0,
    response_time: responseTime,
  };
}

describe("analytics response-time averaging", () => {
  // site_logger adds each request's duration; the management API returns the
  // bucket's TOTAL seconds. One request at 1s, then 99 requests totaling 9.9s:
  // (1 + 9.9) / 100 = 0.109s → 109ms.
  const uneven = [bucket(0, 1, 1.0), bucket(1, 99, 9.9)];
  const AVERAGE_MS = 109;

  it("summariseBuckets divides total duration by total requests", () => {
    expect(summariseBuckets(uneven, "now").avgResponseTimeMs).toBe(AVERAGE_MS);
  });

  it("buildHourlyPeriods divides total duration by the hour's requests", () => {
    const periods = buildHourlyPeriods(uneven, 0, 1);
    expect(periods).toHaveLength(1);
    expect(periods[0].avgResponseTimeMs).toBe(AVERAGE_MS);
  });

  it("reports 0 (not NaN) when a period carries no requests", () => {
    const noTraffic = [bucket(0, 0, 0), bucket(1, 0, 0)];
    expect(summariseBuckets(noTraffic, "now").avgResponseTimeMs).toBe(0);
    expect(buildHourlyPeriods(noTraffic, 0, 1)[0].avgResponseTimeMs).toBe(0);
  });

  it("reports 500ms for 88 requests totaling 44 seconds", () => {
    const requests = [bucket(0, 88, 44)];
    expect(summariseBuckets(requests, "now").avgResponseTimeMs).toBe(500);
    expect(buildHourlyPeriods(requests, 0, 0)[0].avgResponseTimeMs).toBe(500);
  });

  it("keeps the same average when identical requests share or span buckets", () => {
    const separate = [bucket(0, 1, 0.5), bucket(1, 1, 0.5)];
    const combined = [bucket(0, 2, 1)];
    expect(summariseBuckets(separate, "now").avgResponseTimeMs).toBe(500);
    expect(summariseBuckets(combined, "now").avgResponseTimeMs).toBe(500);
  });

  it("retains sub-millisecond precision for the overview to format", () => {
    const fast = [bucket(0, 100, 0.025)];
    expect(summariseBuckets(fast, "now").avgResponseTimeMs).toBeCloseTo(0.25);
    expect(buildHourlyPeriods(fast, 0, 0)[0].avgResponseTimeMs).toBeCloseTo(0.25);
  });
});
