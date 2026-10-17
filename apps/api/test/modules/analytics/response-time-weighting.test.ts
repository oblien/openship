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
  // response_time is the TOTAL response time of the minute's requests, in seconds:
  // site_logger.lua adds every request's time to the minute's `:t` counter and
  // mgmt_api.lua returns that sum. Two minutes with very different request counts:
  // 1 request taking 1000ms, then 99 requests taking 100ms each (9.9s in total).
  // Average = (1.0 + 9.9) / 100 = 0.109s → 109ms.
  const uneven = [bucket(0, 1, 1.0), bucket(1, 99, 9.9)];
  const AVERAGE_MS = 109;

  it("summariseBuckets divides the summed response time by total requests", () => {
    expect(summariseBuckets(uneven, "now").avgResponseTimeMs).toBe(AVERAGE_MS);
  });

  it("buildHourlyPeriods divides the summed response time by the hour's requests", () => {
    const periods = buildHourlyPeriods(uneven, 0, 1);
    expect(periods).toHaveLength(1);
    expect(periods[0].avgResponseTimeMs).toBe(AVERAGE_MS);
  });

  it("reports 0 (not NaN) when a period carries no requests", () => {
    const noTraffic = [bucket(0, 0, 0), bucket(1, 0, 0)];
    expect(summariseBuckets(noTraffic, "now").avgResponseTimeMs).toBe(0);
    expect(buildHourlyPeriods(noTraffic, 0, 1)[0].avgResponseTimeMs).toBe(0);
  });
});
