import { describe, expect, it } from "vitest";
import {
  summariseBuckets,
  buildHourlyPeriods,
} from "../../../src/modules/analytics/analytics.service";

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
  // response_time is a per-minute average (see server_analytics schema). Two
  // minutes with very different request counts: 1 request at 1000ms, then 99 at
  // 100ms. Request-weighted average = (1*1.0 + 99*0.1) / 100 = 0.109s → 109ms.
  const uneven = [bucket(0, 1, 1.0), bucket(1, 99, 0.1)];
  const WEIGHTED_MS = 109;

  it("summariseBuckets weights avgResponseTimeMs by request count", () => {
    expect(summariseBuckets(uneven, "now").avgResponseTimeMs).toBe(WEIGHTED_MS);
  });

  it("buildHourlyPeriods weights avgResponseTimeMs by request count", () => {
    const periods = buildHourlyPeriods(uneven, 0, 1);
    expect(periods).toHaveLength(1);
    expect(periods[0].avgResponseTimeMs).toBe(WEIGHTED_MS);
  });

  it("reports 0 (not NaN) when a period carries no requests", () => {
    const noTraffic = [bucket(0, 0, 0), bucket(1, 0, 0)];
    expect(summariseBuckets(noTraffic, "now").avgResponseTimeMs).toBe(0);
    expect(buildHourlyPeriods(noTraffic, 0, 1)[0].avgResponseTimeMs).toBe(0);
  });
});
