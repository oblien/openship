import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sources: [] as Array<{ kind: string; domain: string; serverId?: string }>,
  rows: [] as Array<{ domain: string; minute: number; requests: number }>,
  live: [] as Array<{ domain: string; minute: number; requests: number }>,
  readLive: vi.fn(),
  query: vi.fn(),
  scrape: vi.fn(async () => {}),
  cloud: vi.fn(),
}));

vi.mock("@repo/db", () => ({ repos: {
  project: { findById: async () => ({ id: "p1", organizationId: "org1" }) },
  analytics: { queryBuckets: h.query },
} }));
vi.mock("@repo/platform/engine/lib/project-analytics", () => ({
  resolveProjectTrafficSources: async (_id: string, options: { domain?: string }) =>
    h.sources.filter((source) => !options.domain || source.domain === options.domain),
  fetchMgmt: h.readLive,
}));
vi.mock("@repo/platform/engine/modules/system/analytics-scraper", () => ({ scrapeServerIfStale: h.scrape }));
vi.mock("@repo/platform/engine/lib/oblien-user-client", () => ({ getAdminOblienClient: () => ({ analytics: { timeseries: h.cloud } }) }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: () => ({ analytics: { timeseries: h.cloud } }) }));

const { getAnalyticsOverview } = await import("@repo/platform/engine/modules/analytics/analytics.service");
const ctx = { organizationId: "org1" } as never;
const now = Date.parse("2026-09-25T10:35:30Z");
const minute = Math.floor(now / 60_000);
const row = (offset: number, requests: number, domain = "web.example.com") => ({ domain, minute: minute + offset, requests });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  h.sources = [
    { kind: "self-hosted", domain: "web.example.com", serverId: "s1" },
    { kind: "self-hosted", domain: "api.example.com", serverId: "s1" },
  ];
  h.rows = [];
  h.live = [];
  h.scrape.mockClear();
  h.cloud.mockReset();
  h.query.mockReset().mockImplementation(async ({ domain, fromMinute, toMinute }) =>
    h.rows.filter((row) => row.domain === domain && row.minute >= fromMinute && row.minute <= toMinute)
      .map((row) => ({ ...row, uniqueRequests: row.requests, bandwidthIn: 0, bandwidthOut: 0, responseTime: 0 })),
  );
  h.readLive.mockReset().mockImplementation(async (_server: string, path: string) => {
    const params = new URL(path, "http://edge.test").searchParams;
    return { buckets: h.live.filter((row) => row.domain === params.get("domain") &&
      row.minute >= Number(params.get("from")) && row.minute <= Number(params.get("to")))
      .map((row) => ({ ...row, unique_requests: row.requests, bandwidth_in: 0, bandwidth_out: 0, response_time: 0 })) };
  });
});
afterEach(() => vi.useRealTimers());

describe("project traffic snapshot", () => {
  it("includes retained history before the latest DB row and all project domains", async () => {
    h.rows = [row(-30, 90)];
    h.live = [row(-180, 110), row(-30, 0), row(0, 5), row(0, 1000, "api.example.com")];
    const result = await getAnalyticsOverview(ctx, "p1");
    expect(result.summary.totalRequests).toBe(1205);
    expect(result.periods.reduce((sum, period) => sum + period.requests, 0)).toBe(1205);
    expect(result.periods.find((period) => Date.parse(period.from) <= (minute - 180) * 60_000 &&
      Date.parse(period.to) > (minute - 180) * 60_000)?.requests).toBe(110);
    expect(result.periods[0].from).toBe(new Date(now - 86_400_000).toISOString());
    expect(result.periods.at(-1)?.to).toBe(new Date(now).toISOString());
    expect(h.scrape).toHaveBeenCalledTimes(1); // one server, two domains
  });

  it("deduplicates a live snapshot persisted by a concurrent scrape", async () => {
    h.live = [row(-10, 80), row(0, 7)];
    h.rows = [row(-10, 80)];
    const result = await getAnalyticsOverview(ctx, "p1");
    expect(result.summary.totalRequests).toBe(87);
    expect(result.periods.reduce((sum, period) => sum + period.requests, 0)).toBe(87);
  });

  it("allows an explicit domain scope without losing the project-wide default", async () => {
    h.live = [row(0, 10), row(0, 50, "api.example.com")];
    expect((await getAnalyticsOverview(ctx, "p1", undefined, undefined, "api.example.com")).summary.totalRequests).toBe(50);
    expect((await getAnalyticsOverview(ctx, "p1")).summary.totalRequests).toBe(60);
  });

  it("reads the retained tail of a longer historical window without exceeding the edge cap", async () => {
    h.rows = [row(-3 * 1440, 300)];
    h.live = [row(0, 7)];
    const result = await getAnalyticsOverview(ctx, "p1", new Date(now - 7 * 86_400_000).toISOString());
    expect(result.summary.totalRequests).toBe(307);
    const query = new URL(h.readLive.mock.calls[0][1], "http://edge.test").searchParams;
    expect(Number(query.get("from"))).toBe(minute - 1440);
    expect(Number(query.get("to"))).toBe(minute);
  });

  it("keeps archived traffic available when the live read fails", async () => {
    h.rows = [row(-30, 90)];
    h.readLive.mockRejectedValue(new Error("SSH unreachable"));
    const result = await getAnalyticsOverview(ctx, "p1");
    expect(result.summary.totalRequests).toBe(90);
    expect(result.periods.reduce((sum, period) => sum + period.requests, 0)).toBe(90);
  });

  it("keeps cloud totals and plotted hours on the same window and aggregates domains", async () => {
    h.sources = h.sources.map((source) => ({ kind: "cloud", domain: source.domain }));
    const currentHour = Math.floor(now / 3_600_000) * 3600;
    const bucket = (timestamp: number, requests: number) => ({
      timestamp, requests, bandwidth_in: 0, bandwidth_out: 0, response_time_sum: 0, unique_visitors: 1,
    });
    h.cloud.mockImplementation(async (domain: string) => ({ data: { data: [
      bucket(currentHour - 30 * 3600, 999), // upstream overfetch must not inflate the summary
      bucket(currentHour, domain === "web.example.com" ? 10 : 50),
    ] } }));
    const result = await getAnalyticsOverview(ctx, "p1");
    expect(result.summary.totalRequests).toBe(60);
    expect(result.periods.reduce((sum, period) => sum + period.requests, 0)).toBe(60);
    expect(result.periods.at(-1)?.to).toBe(new Date(now).toISOString());
    expect(h.scrape).not.toHaveBeenCalled();
  });
});
