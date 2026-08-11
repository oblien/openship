import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `analytics:scrape` sweep.
 *
 * Why it exists: the pull used to fire ONLY when someone opened the analytics tab.
 * Both key classes live in the edge's shared dict under a TTL (24h for minute
 * buckets, 48h for the daily rollup), so "nobody looked" and "the data was never
 * persisted" were the same event — and indistinguishable afterwards, because an
 * unflushed minute and a minute with no traffic both read as a missing key.
 *
 * These tests pin the properties that make the job safe to run alongside the
 * read-triggered scrape it did not replace.
 */

const h = vi.hoisted(() => ({
  servers: [] as Array<{ id: string }>,
  cloudMode: false,
  /** serverId → whether the staleness gate says "recently scraped". */
  throttled: new Set<string>(),
  /** serverIds actually handed to scrapeServer. */
  scraped: [] as string[],
  /** serverIds whose scrape throws. */
  failing: new Set<string>(),
  totals: null as unknown,
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: { list: vi.fn(async () => h.servers) },
    analytics: {
      getLastScrapedMinute: vi.fn(async () => null),
      upsertBuckets: vi.fn(async () => {}),
      upsertGeo: vi.fn(async () => {}),
    },
  },
}));

vi.mock("../../../src/config", () => ({ env: { get CLOUD_MODE() { return h.cloudMode; } } }));

// A cacheStore whose `get` reports the throttle state the test set up.
vi.mock("../../../src/lib/cache-store", () => ({
  cacheStore: vi.fn(async () => ({
    get: async (key: string) => (h.throttled.has(key.replace("lastAt:", "")) ? 1 : undefined),
    set: async () => {},
  })),
}));

vi.mock("../../../src/lib/system-debug", () => ({
  systemDebug: vi.fn(),
  formatDuration: () => "1ms",
}));

vi.mock("../../../src/lib/project-analytics", () => ({
  probeMgmt: vi.fn(async (serverId: string) => {
    h.scraped.push(serverId);
    if (h.failing.has(serverId)) throw new Error("ssh refused");
    return true;
  }),
  fetchMgmt: vi.fn(async () => h.totals),
  postMgmt: vi.fn(async () => ({ buckets: [], flushed: 0 })),
}));

const { runAnalyticsScrapeSweep } = await import("../../../src/modules/system/analytics-scraper");

beforeEach(() => {
  h.servers = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
  h.cloudMode = false;
  h.throttled = new Set();
  h.scraped = [];
  h.failing = new Set();
  h.totals = { domains: [] };
});

describe("runAnalyticsScrapeSweep", () => {
  it("sweeps every managed server, so persistence no longer depends on someone looking", async () => {
    const r = await runAnalyticsScrapeSweep();
    expect(h.scraped.sort()).toEqual(["s1", "s2", "s3"]);
    expect(r.servers).toBe(3);
  });

  it("skips a server the read path already scraped — the staleness gate is shared", async () => {
    // Someone opened s2's analytics moments ago; there is nothing left to collect.
    h.throttled.add("s2");
    await runAnalyticsScrapeSweep();
    expect(h.scraped).not.toContain("s2");
    expect(h.scraped.sort()).toEqual(["s1", "s3"]);
  });

  it("keeps going after an unreachable server instead of failing the job", async () => {
    h.failing.add("s1");
    await expect(runAnalyticsScrapeSweep()).resolves.toMatchObject({ servers: 3 });
    // s2 and s3 were still visited.
    expect(h.scraped).toContain("s2");
    expect(h.scraped).toContain("s3");
  });

  it("goes one server at a time — a 50-box control plane must not connect to all at once", async () => {
    let concurrent = 0;
    let peak = 0;
    const { probeMgmt } = await import("../../../src/lib/project-analytics");
    (probeMgmt as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (serverId: string) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        h.scraped.push(serverId);
        return true;
      },
    );

    await runAnalyticsScrapeSweep();
    expect(peak).toBe(1);
  });

  it("hard-stops in cloud mode — the SaaS has no managed servers to dial", async () => {
    h.cloudMode = true;
    const r = await runAnalyticsScrapeSweep();
    expect(r).toEqual({ servers: 0, skipped: 0 });
    expect(h.scraped).toEqual([]);
  });

  it("is a no-op with no servers configured", async () => {
    h.servers = [];
    await expect(runAnalyticsScrapeSweep()).resolves.toEqual({ servers: 0, skipped: 0 });
  });

  it("scrapes a server again after its throttle expires", async () => {
    // Regression: the in-flight-dedup entry was released in a `finally` that sat
    // BELOW the throttled-path `return`, so a throttled call never cleared it. The
    // resolved promise stayed in the map and every later call short-circuited on
    // it — one throttled read permanently disabled scraping for that server until
    // the API restarted, presenting as "analytics stopped updating".
    h.servers = [{ id: "s1" }];
    h.throttled.add("s1");
    await runAnalyticsScrapeSweep();
    expect(h.scraped).toEqual([]); // throttled, as intended

    h.throttled.delete("s1"); // window elapsed
    await runAnalyticsScrapeSweep();
    expect(h.scraped).toEqual(["s1"]);
  });
});
