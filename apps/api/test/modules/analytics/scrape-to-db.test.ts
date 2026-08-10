import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the edge measures must arrive in Postgres unchanged.
 *
 * The read side (geo.service) already has tests. This covers the WRITE side, which had
 * none: `scrapeServer` → `repos.analytics.upsertGeo` / `upsertBuckets`. That is the seam
 * where a per-code status map could quietly get bucketed into classes, or a country map
 * dropped, and nothing downstream would be able to tell — the dashboard would just show
 * less than the edge knew.
 *
 * ── The fixture is REAL ─────────────────────────────────────────────────────
 *
 * COLLECTED below is the verbatim response of `POST /analytics/collect` from a running
 * `openship-edge` container, after driving it with a known spread of requests:
 *
 *   US 8.8.8.8      5 × 200, 1 × 201, 2 × 404      → 8
 *   DE 78.46.0.1    1 × 200, 2 × 301, 1 × 304      → 4
 *   JP 133.11.0.1   1 × 500, 1 × 502               → 2
 *   BR 200.160.0.1  2 × 429, 1 × 200               → 3
 *
 * (Sent through a trusted `CF-Connecting-IP`, so the countries are the real-ip block's
 * work too — see packages/adapters/src/infra/edge-real-ip.ts.)
 *
 * Copied rather than invented because an invented fixture only proves the code agrees
 * with my idea of the edge's output. The whole class of bug this guards against is the
 * two disagreeing — a renamed field, a nested wrapper, a stringified count.
 */

const COLLECTED = {
  day: "20260803",
  domains: {
    "shop.example.com": {
      buckets: [
        {
          minute: 29763331,
          requests: 17,
          unique_requests: 17,
          bandwidth_in: 2120,
          bandwidth_out: 3131,
          response_time: 0,
          countries: { JP: 2, BR: 3, DE: 4, US: 8 },
        },
      ],
      flushed: 1,
      rollup: {
        day: "20260803",
        countries: { JP: 2, BR: 3, US: 8, DE: 4 },
        visitors: 4,
        paths: {
          "/moved": 2,
          "/boom": 1,
          "/missing": 2,
          "/gateway": 1,
          "/notmodified": 1,
          "/throttled": 2,
          "/": 7,
          "/created": 1,
        },
        statuses: { "201": 1, "200": 7, "304": 1, "301": 2, "502": 1, "404": 2, "429": 2, "500": 1 },
      },
    },
  },
};

const h = vi.hoisted(() => ({
  geoUpserts: [] as Array<Record<string, unknown>>,
  bucketUpserts: [] as Array<Record<string, unknown>>,
  lastMinute: null as number | null,
  totals: { domains: [{ domain: "shop.example.com" }] } as unknown,
  collected: null as unknown,
  servers: [] as unknown[],
}));

vi.mock("@repo/db", () => ({
  repos: {
    analytics: {
      getLastScrapedMinute: vi.fn(async () => h.lastMinute),
      upsertGeo: vi.fn(async (rows: Array<Record<string, unknown>>) => {
        h.geoUpserts.push(...rows);
      }),
      upsertBuckets: vi.fn(async (rows: Array<Record<string, unknown>>) => {
        h.bucketUpserts.push(...rows);
      }),
    },
    server: { listForScan: vi.fn(async () => h.servers) },
  },
}));

vi.mock("../../../src/lib/project-analytics", () => ({
  fetchMgmt: vi.fn(async (_serverId: string, path: string) =>
    path.startsWith("/analytics/totals") ? h.totals : null,
  ),
  postMgmtJson: vi.fn(async () => h.collected),
  probeMgmt: vi.fn(async () => true),
}));

/**
 * Driven through the EXPORTED entry point, with only its staleness cache stubbed.
 *
 * `scrapeServer` itself is deliberately private — `scrapeServerIfStale` wraps it with the
 * throttle and the in-flight dedup, and exporting the raw function to make it testable
 * would offer every caller a way around both. Stubbing the cache to always report "not
 * scraped recently" exercises the real path instead.
 */
vi.mock("../../../src/lib/cache-store", () => ({
  cacheStore: vi.fn(async () => ({
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
  })),
}));

const { scrapeServerIfStale } = await import("../../../src/modules/system/analytics-scraper");
const scrapeServer = scrapeServerIfStale;

beforeEach(() => {
  h.geoUpserts = [];
  h.bucketUpserts = [];
  h.lastMinute = null;
  h.totals = { domains: [{ domain: "shop.example.com" }] };
  h.collected = structuredClone(COLLECTED);
});

/** The single geo row the scrape should have written. */
async function scrapeAndGetRollup() {
  await scrapeServer("s1");
  expect(h.geoUpserts).toHaveLength(1);
  return h.geoUpserts[0] as {
    serverId: string;
    domain: string;
    day: string;
    countries: Record<string, number>;
    statuses: Record<string, number>;
    paths: Record<string, number>;
    visitors: number;
  };
}

describe("status codes reach the DB per EXACT code", () => {
  it("persists every individual code, not 2xx/3xx/4xx/5xx classes", async () => {
    const row = await scrapeAndGetRollup();
    // The exact map the edge reported, key for key.
    expect(row.statuses).toEqual({
      "200": 7,
      "201": 1,
      "301": 2,
      "304": 1,
      "404": 2,
      "429": 2,
      "500": 1,
      "502": 1,
    });
    // And explicitly NOT collapsed on the way in. Bucketing belongs in the UI, where it
    // can be undone; bucketing here would destroy the data permanently.
    for (const cls of ["2xx", "3xx", "4xx", "5xx"]) {
      expect(row.statuses).not.toHaveProperty(cls);
    }
  });

  it("distinguishes codes that share a class", async () => {
    const row = await scrapeAndGetRollup();
    // The point of per-code: 4xx is 4, but "which 4xx" is the actionable half — 2 × 404
    // (a broken link) reads completely differently from 2 × 429 (a client being limited).
    expect(row.statuses["404"]).toBe(2);
    expect(row.statuses["429"]).toBe(2);
    expect(row.statuses["500"]).toBe(1);
    expect(row.statuses["502"]).toBe(1);
  });

  it("keeps counts as numbers, so a sum is not string concatenation", async () => {
    const row = await scrapeAndGetRollup();
    for (const v of Object.values(row.statuses)) expect(typeof v).toBe("number");
    const total = Object.values(row.statuses).reduce((a, b) => a + b, 0);
    // 17 requests were made, and every one of them produced a status.
    expect(total).toBe(17);
  });
});

describe("countries reach the DB", () => {
  it("persists the per-country map from the rollup", async () => {
    const row = await scrapeAndGetRollup();
    expect(row.countries).toEqual({ US: 8, DE: 4, BR: 3, JP: 2 });
  });

  it("also persists the per-minute country breakdown on the bucket row", async () => {
    await scrapeServer("s1");
    expect(h.bucketUpserts).toHaveLength(1);
    const b = h.bucketUpserts[0] as Record<string, unknown>;
    expect(b.countries).toEqual({ US: 8, DE: 4, BR: 3, JP: 2 });
    // Field RENAMES are the failure this catches: the edge says `unique_requests` and
    // `bandwidth_in`, the column is uniqueRequests / bandwidthIn.
    expect(b.requests).toBe(17);
    expect(b.uniqueRequests).toBe(17);
    expect(b.bandwidthIn).toBe(2120);
    expect(b.bandwidthOut).toBe(3131);
    expect(b.minute).toBe(29763331);
  });

  it("agrees with the status total — same requests counted two ways", async () => {
    const row = await scrapeAndGetRollup();
    const byCountry = Object.values(row.countries).reduce((a, b) => a + b, 0);
    const byStatus = Object.values(row.statuses).reduce((a, b) => a + b, 0);
    expect(byCountry).toBe(byStatus);
  });
});

describe("paths and visitors", () => {
  it("persists normalized paths and the distinct-visitor count", async () => {
    const row = await scrapeAndGetRollup();
    expect(row.paths["/"]).toBe(7);
    expect(row.paths["/missing"]).toBe(2);
    // Four distinct client addresses → four visitors. Before the real-ip block this would
    // have been 1, because every request's peer was the same proxy.
    expect(row.visitors).toBe(4);
  });

  it("writes under the edge's own day key, not the control plane's date", async () => {
    const row = await scrapeAndGetRollup();
    // The edge stamps `os.date("!%Y%m%d")`. Using the API host's local date instead would
    // split one edge-day across two rows for any control plane not on UTC.
    expect(row.day).toBe("20260803");
    expect(row.serverId).toBe("s1");
    expect(row.domain).toBe("shop.example.com");
  });
});

describe("partial and degenerate payloads", () => {
  it("still writes when geo is unavailable but statuses exist", async () => {
    // Every containerized edge was in this state until the GeoIP DB was baked into the
    // image. Gating the write on countries discarded the status, path and visitor counts
    // it did have.
    const c = structuredClone(COLLECTED);
    c.domains["shop.example.com"].rollup.countries = {};
    h.collected = c;
    const row = await scrapeAndGetRollup();
    expect(row.countries).toEqual({});
    expect(row.statuses["200"]).toBe(7);
  });

  it("writes nothing when every dimension is empty", async () => {
    const c = structuredClone(COLLECTED);
    c.domains["shop.example.com"].rollup = {
      day: "20260803",
      countries: {},
      visitors: 0,
      paths: {},
      statuses: {},
    };
    c.domains["shop.example.com"].buckets = [];
    h.collected = c;
    await scrapeServer("s1");
    // An empty row would overwrite a populated one for the same (server, domain, day),
    // since the upsert is last-write-wins by design.
    expect(h.geoUpserts).toHaveLength(0);
  });

  it("does not throw when the edge answers nothing", async () => {
    h.collected = null;
    await expect(scrapeServer("s1")).resolves.toBeUndefined();
    expect(h.geoUpserts).toHaveLength(0);
  });

  it("skips a domain missing from the collect response", async () => {
    h.totals = { domains: [{ domain: "shop.example.com" }, { domain: "other.example.com" }] };
    await scrapeServer("s1");
    // One requested domain answered; the other must be skipped, not written as zeros.
    expect(h.geoUpserts.map((r) => r.domain)).toEqual(["shop.example.com"]);
  });
});
