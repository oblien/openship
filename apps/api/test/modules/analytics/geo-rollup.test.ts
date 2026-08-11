import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daily geo rollup has ONE non-obvious invariant, and these tests exist to pin
 * it: today's numbers must come from EITHER the DB row or the live edge read, never
 * both.
 *
 * The edge holds each day's counters as running TOTALS with a 48h TTL, not as
 * deltas — every scrape re-reads the whole day and the upsert overwrites. So the
 * persisted row for today and a live read of today are two snapshots of the same
 * counter. Summing them roughly doubles today's traffic, which is the kind of bug
 * that looks like real growth on a chart.
 */

const h = vi.hoisted(() => ({
  project: { id: "p1", organizationId: "org1", slug: "app" } as Record<string, unknown> | null,
  geoRows: [] as Array<Record<string, unknown>>,
  /** path → JSON, for the mgmt API. */
  mgmt: new Map<string, unknown>(),
  sources: [] as unknown[],
  scrape: vi.fn(async () => {}),
  cloudCalls: [] as Array<Record<string, unknown>>,
  cloudResult: null as unknown,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn(async () => h.project) },
    analytics: {
      queryGeoRange: vi.fn(async () => h.geoRows),
    },
  },
}));

vi.mock("../../../src/lib/project-analytics", () => ({
  resolveProjectTrafficSources: vi.fn(async () => h.sources),
  fetchMgmt: vi.fn(async (_serverId: string, path: string) => {
    for (const [prefix, value] of h.mgmt) {
      if (path.startsWith(prefix)) return value;
    }
    return null;
  }),
}));

vi.mock("../../../src/modules/system/analytics-scraper", () => ({
  scrapeServerIfStale: h.scrape,
}));

vi.mock("../../../src/modules/cloud/cloud-analytics.service", () => ({
  proxyCloudAnalytics: vi.fn(async (_org: string, input: Record<string, unknown>) => {
    h.cloudCalls.push(input);
    return h.cloudResult;
  }),
}));

const { getProjectGeo } = await import("../../../src/modules/analytics/geo.service");

const ctx = { organizationId: "org1" } as never;

/** "YYYYMMDD" in UTC, matching the edge's os.date("!%Y%m%d") keys. */
const dayKey = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");

beforeEach(() => {
  h.project = { id: "p1", organizationId: "org1", slug: "app" };
  h.geoRows = [];
  h.mgmt = new Map();
  h.sources = [{ kind: "self-hosted", domain: "a.com", serverId: "s1", deployTarget: "server" }];
  h.cloudCalls = [];
  h.cloudResult = null;
  h.scrape.mockClear();
  // Default: geo is healthy, so tests exercise data paths rather than the advisory.
  h.mgmt.set("/status", { ok: true, geo: { available: true }, dicts: {} });
});

describe("self-hosted daily rollup", () => {
  it("does NOT add the live read to today's persisted row — they are the same counter", async () => {
    h.geoRows = [{ day: dayKey(), countries: { US: 100 }, visitors: 40, paths: {}, statuses: {} }];
    h.mgmt.set("/analytics/geo", { countries: { US: 120 }, visitors: 45, paths: {}, statuses: {} });

    const r = await getProjectGeo(ctx, "p1");

    // 120, not 220. Live is fresher, so it REPLACES the row for today.
    expect(r.total).toBe(120);
    expect(r.countries).toEqual([{ code: "US", count: 120, pct: 100 }]);
    expect(r.visitorDays).toBe(45);
  });

  it("falls back to today's persisted row when the edge does not answer", async () => {
    h.geoRows = [{ day: dayKey(), countries: { US: 100 }, visitors: 40, paths: {}, statuses: {} }];
    // No /analytics/geo entry → fetchMgmt resolves null (unreachable edge).

    const r = await getProjectGeo(ctx, "p1");
    expect(r.total).toBe(100);
    expect(r.visitorDays).toBe(40);
  });

  it("sums PAST days and adds the live read for today exactly once", async () => {
    h.geoRows = [
      { day: dayKey(-2), countries: { US: 10, DE: 5 }, visitors: 7, paths: {}, statuses: {} },
      { day: dayKey(-1), countries: { US: 20 }, visitors: 9, paths: {}, statuses: {} },
      { day: dayKey(), countries: { US: 1 }, visitors: 1, paths: {}, statuses: {} },
    ];
    h.mgmt.set("/analytics/geo", { countries: { US: 30 }, visitors: 11, paths: {}, statuses: {} });

    const r = await getProjectGeo(ctx, "p1");

    // Past: 10+5+20 = 35. Today: 30 live (the stale 1 is dropped, not added).
    expect(r.total).toBe(65);
    expect(r.countries.find((c) => c.code === "US")?.count).toBe(60);
    expect(r.countries.find((c) => c.code === "DE")?.count).toBe(5);
    // Upper bound: per-day distinct summed. peakDay is the lower bound.
    expect(r.visitorDays).toBe(7 + 9 + 11);
    expect(r.peakDayVisitors).toBe(11);
  });

  it("merges top paths and status codes across days", async () => {
    h.geoRows = [
      { day: dayKey(-1), countries: {}, visitors: 0, paths: { "/": 5, "/a": 2 }, statuses: { "200": 7 } },
    ];
    h.mgmt.set("/analytics/geo", { countries: {}, visitors: 0, paths: { "/": 3 }, statuses: { "404": 1 } });

    const r = await getProjectGeo(ctx, "p1");
    expect(r.topPaths).toEqual([
      { path: "/", count: 8 },
      { path: "/a", count: 2 },
    ]);
    expect(r.statuses).toEqual({ "200": 7, "404": 1 });
  });

  it("reports geoAvailable=false so an empty map reads as broken, not as no traffic", async () => {
    h.mgmt.set("/status", {
      ok: true,
      geo: { available: false, reason: "maxminddb FFI binding unavailable" },
      dicts: {},
    });
    const r = await getProjectGeo(ctx, "p1");
    expect(r.geoAvailable).toBe(false);
  });

  it("assumes geo is fine when /status is unreachable — an offline box is not a geo fault", async () => {
    h.mgmt = new Map(); // nothing answers
    const r = await getProjectGeo(ctx, "p1");
    expect(r.geoAvailable).toBe(true);
  });

  it("flags the visitor count approximate when the edge's visitor zone is evicting", async () => {
    h.mgmt.set("/status", {
      ok: true,
      geo: { available: true },
      // Under 10% headroom → the distinct-visitor set is LRU-evicting and undercounts.
      dicts: { visitors: { capacity: 1000, free_space: 50 } },
    });
    const r = await getProjectGeo(ctx, "p1");
    expect(r.approximate).toBe(true);
  });

  it("drops non-country keys so internal bookkeeping never plots as a country", async () => {
    h.geoRows = [
      { day: dayKey(-1), countries: { US: 5, pn: 90, other: 3 }, visitors: 0, paths: {}, statuses: {} },
    ];
    const r = await getProjectGeo(ctx, "p1");
    expect(r.countries.map((c) => c.code)).toEqual(["US"]);
    expect(r.total).toBe(5);
  });

  it("viewing also triggers a scrape, for freshness on top of the scheduled sweep", async () => {
    // The `analytics:scrape` job owns durability; this call is what makes an open
    // tab show the last minute rather than the last sweep. It self-throttles, so
    // the two collapse instead of competing.
    await getProjectGeo(ctx, "p1");
    expect(h.scrape).toHaveBeenCalledWith("s1");
  });
});

describe("cloud", () => {
  beforeEach(() => {
    h.sources = [{ kind: "cloud", domain: "a.com", deployTarget: "cloud" }];
  });

  it("asks Oblien for geo with only the allowlisted window params", async () => {
    h.cloudResult = { success: true, data: { total: 3, countries: [{ code: "FR", count: 3, pct: 100 }] } };
    const r = await getProjectGeo(ctx, "p1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");

    expect(h.cloudCalls).toHaveLength(1);
    expect(h.cloudCalls[0].operation).toBe("geo");
    expect(Object.keys(h.cloudCalls[0].params as object).sort()).toEqual(["from", "to"]);
    expect(r.source).toBe("cloud");
    expect(r.countries).toEqual([{ code: "FR", count: 3, pct: 100 }]);
  });

  it("walks nested data wrappers — the cloud proxy re-wraps the SDK response", async () => {
    // SDK gives { success, data: {...} }; the proxy wraps that again as { data: ... }.
    h.cloudResult = {
      data: { success: true, data: { total: 2, countries: [{ code: "JP", count: 2, pct: 100 }] } },
    };
    const r = await getProjectGeo(ctx, "p1");
    expect(r.countries).toEqual([{ code: "JP", count: 2, pct: 100 }]);
  });

  it("never reaches out to a server for a cloud project", async () => {
    h.cloudResult = { data: { total: 0, countries: [] } };
    await getProjectGeo(ctx, "p1");
    expect(h.scrape).not.toHaveBeenCalled();
  });
});

describe("degenerate inputs", () => {
  it("returns a clean empty for a project with no resolvable traffic source", async () => {
    h.sources = [];
    const r = await getProjectGeo(ctx, "p1");
    expect(r).toMatchObject({ total: 0, countries: [], visitorDays: 0, source: "none" });
  });

  it("404s a project outside the caller's organization", async () => {
    h.project = { id: "p1", organizationId: "other-org", slug: "app" };
    await expect(getProjectGeo(ctx, "p1")).rejects.toThrow();
  });
});
