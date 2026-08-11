import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resource usage over time.
 *
 * Three invariants, each with a wrong version that still renders a plausible chart:
 *   - network counters are CUMULATIVE, so the series must be differenced, per series,
 *     clamped at 0 across a restart
 *   - gaps must survive as explicit zero buckets, not a compressed axis (an outage
 *     that silently disappears is worse than no chart)
 *   - "All" is the per-bucket sum across services, and must equal the sum of the
 *     individual series reads
 */

const h = vi.hoisted(() => ({
  project: { id: "p1", organizationId: "org1" } as Record<string, unknown> | null,
  services: [] as Array<{ id: string; name: string }>,
  rows: [] as Array<Record<string, unknown>>,
  lastQuery: null as Record<string, unknown> | null,
}));

vi.mock("@repo/db", () => ({
  RESOURCE_BUCKET_MINUTES: 5,
  SINGLE_APP_SERVICE_KEY: "__app__",
  repos: {
    project: { findById: vi.fn(async () => h.project) },
    service: { listByProject: vi.fn(async () => h.services) },
    resourceUsage: {
      querySamples: vi.fn(async (q: Record<string, unknown>) => {
        h.lastQuery = q;
        const from = q.fromMinute as number;
        const to = q.toMinute as number;
        return h.rows.filter(
          (r) =>
            (r.minute as number) >= from &&
            (r.minute as number) <= to &&
            (!q.serviceKey || r.serviceKey === q.serviceKey),
        );
      }),
    },
  },
}));

const { getProjectUsageHistory } = await import("../../../src/modules/monitoring/usage-history");

const ctx = { organizationId: "org1" } as never;

const sample = (
  minute: number,
  serviceKey: string,
  cpu: number,
  mem: number,
  rx = 0,
  tx = 0,
) => ({ minute, serviceKey, cpuPercent: cpu, memoryMb: mem, networkRxBytes: rx, networkTxBytes: tx });

/** A window whose span keeps granularity at the raw 5 minutes. */
const BASE = 1_000_000; // arbitrary epoch minute, already a multiple of 5
const winFrom = new Date(BASE * 60_000).toISOString();
const winTo = new Date((BASE + 20) * 60_000).toISOString();

beforeEach(() => {
  h.project = { id: "p1", organizationId: "org1" };
  h.services = [
    { id: "sv-web", name: "web" },
    { id: "sv-db", name: "db" },
  ];
  h.rows = [];
  h.lastQuery = null;
});

describe("granularity + gap fill", () => {
  it("keeps raw 5-minute buckets for a short window", async () => {
    h.rows = [sample(BASE, "sv-web", 10, 100)];
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    expect(r.granularityMinutes).toBe(5);
    // BASE..BASE+20 inclusive at width 5 → 5 buckets.
    expect(r.buckets.map((b) => b.minute)).toEqual([
      BASE, BASE + 5, BASE + 10, BASE + 15, BASE + 20,
    ]);
  });

  it("renders a gap as explicit zero buckets flagged hasData=false", async () => {
    // Samples at the two ends, nothing in between.
    h.rows = [sample(BASE, "sv-web", 10, 100), sample(BASE + 20, "sv-web", 20, 200)];
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });

    expect(r.buckets).toHaveLength(5);
    // The middle three must EXIST — collapsing them would make an outage invisible.
    expect(r.buckets.map((b) => b.hasData)).toEqual([true, false, false, false, true]);
    expect(r.buckets[1]).toMatchObject({ cpuPercent: 0, memoryMb: 0 });
  });

  it("coarsens a wide window instead of shipping thousands of points", async () => {
    const from = new Date(BASE * 60_000).toISOString();
    const to = new Date((BASE + 7 * 24 * 60) * 60_000).toISOString(); // 7 days
    const r = await getProjectUsageHistory(ctx, "p1", { from, to });

    expect(r.granularityMinutes).toBeGreaterThan(5);
    // Still a multiple of the base width, so bucket edges line up with stored rows.
    expect(r.granularityMinutes % 5).toBe(0);
    expect(r.buckets.length).toBeLessThanOrEqual(200);
  });

  it("queries through the END of the last bucket, not its start", async () => {
    await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    // Otherwise the final bucket only ever holds the sample on its exact boundary.
    expect(h.lastQuery!.toMinute).toBe(BASE + 20 + 5 - 1);
  });
});

describe("network deltas", () => {
  it("differences the cumulative counters rather than plotting the ramp", async () => {
    h.rows = [
      sample(BASE, "sv-web", 1, 1, 1000, 500),
      sample(BASE + 5, "sv-web", 1, 1, 1500, 800),
      sample(BASE + 10, "sv-web", 1, 1, 1600, 900),
    ];
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });

    // First sample has no predecessor → 0, then the per-bucket deltas.
    expect(r.buckets.slice(0, 3).map((b) => b.networkRxBytes)).toEqual([0, 500, 100]);
    expect(r.buckets.slice(0, 3).map((b) => b.networkTxBytes)).toEqual([0, 300, 100]);
  });

  it("clamps at 0 across a restart instead of plotting a negative spike", async () => {
    h.rows = [
      sample(BASE, "sv-web", 1, 1, 9000, 9000),
      sample(BASE + 5, "sv-web", 1, 1, 40, 30), // container restarted, counter reset
    ];
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    expect(r.buckets[1].networkRxBytes).toBe(0);
    expect(r.buckets[1].networkTxBytes).toBe(0);
  });

  it("differences PER SERIES — services' counters are independent", async () => {
    h.rows = [
      sample(BASE, "sv-web", 1, 1, 1000, 0),
      sample(BASE, "sv-db", 1, 1, 50_000, 0),
      sample(BASE + 5, "sv-web", 1, 1, 1100, 0),
      sample(BASE + 5, "sv-db", 1, 1, 50_200, 0),
    ];
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    // 100 + 200. Differencing across an interleaved stream would have subtracted
    // web's total from db's and produced garbage.
    expect(r.buckets[1].networkRxBytes).toBe(300);
  });
});

describe("All vs per-service", () => {
  it("All sums services per bucket and averages over sample rounds, not rows", async () => {
    h.rows = [
      sample(BASE, "sv-web", 10, 100),
      sample(BASE, "sv-db", 30, 300),
    ];
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    // One sample round in the bucket, two services → the stack used 40%, not 20%.
    expect(r.buckets[0].cpuPercent).toBe(40);
    expect(r.buckets[0].memoryMb).toBe(400);
    expect(r.serviceKey).toBeNull();
  });

  it("All equals the sum of the individual series reads", async () => {
    h.rows = [
      sample(BASE, "sv-web", 10, 100),
      sample(BASE, "sv-db", 30, 300),
      sample(BASE + 5, "sv-web", 12, 110),
      sample(BASE + 5, "sv-db", 8, 90),
    ];
    const all = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    const web = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo, serviceKey: "sv-web" });
    const db = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo, serviceKey: "sv-db" });

    for (let i = 0; i < all.buckets.length; i++) {
      expect(all.buckets[i].cpuPercent).toBeCloseTo(
        web.buckets[i].cpuPercent + db.buckets[i].cpuPercent,
        5,
      );
    }
  });

  it("scopes to one service when asked", async () => {
    h.rows = [sample(BASE, "sv-web", 10, 100), sample(BASE, "sv-db", 30, 300)];
    const r = await getProjectUsageHistory(ctx, "p1", {
      from: winFrom, to: winTo, serviceKey: "sv-db",
    });
    expect(r.serviceKey).toBe("sv-db");
    expect(r.buckets[0].cpuPercent).toBe(30);
  });

  it("averages multiple rounds inside one bucket rather than summing them", async () => {
    // Width 5 means one round per bucket normally; force two rows into one bucket by
    // widening the window so granularity > 5.
    const from = new Date(BASE * 60_000).toISOString();
    const to = new Date((BASE + 7 * 24 * 60) * 60_000).toISOString();
    h.rows = [
      sample(BASE, "sv-web", 10, 100),
      sample(BASE + 5, "sv-web", 30, 300),
    ];
    const r = await getProjectUsageHistory(ctx, "p1", { from, to });
    const first = r.buckets.find((b) => b.hasData)!;
    // Two rounds, one service → mean of 10 and 30. Summing would report 40% for a
    // container that never exceeded 30.
    expect(first.cpuPercent).toBe(20);
    expect(first.memoryMb).toBe(200);
  });

  it("lists selectable services for the picker", async () => {
    const r = await getProjectUsageHistory(ctx, "p1", { from: winFrom, to: winTo });
    expect(r.services).toEqual([
      { serviceKey: "sv-web", name: "web" },
      { serviceKey: "sv-db", name: "db" },
    ]);
  });
});

describe("guards", () => {
  it("ignores a serviceKey that isn't this project's — no cross-project reads", async () => {
    h.rows = [sample(BASE, "sv-web", 10, 100)];
    const r = await getProjectUsageHistory(ctx, "p1", {
      from: winFrom, to: winTo, serviceKey: "sv-SOMEONE-ELSE",
    });
    // Falls back to All rather than querying the foreign key.
    expect(r.serviceKey).toBeNull();
    expect(h.lastQuery!.serviceKey).toBeUndefined();
  });

  it("accepts the single-app sentinel", async () => {
    h.services = [];
    h.rows = [sample(BASE, "__app__", 7, 70)];
    const r = await getProjectUsageHistory(ctx, "p1", {
      from: winFrom, to: winTo, serviceKey: "__app__",
    });
    expect(r.serviceKey).toBe("__app__");
    expect(r.buckets[0].cpuPercent).toBe(7);
  });

  it("404s a project outside the caller's organization", async () => {
    h.project = { id: "p1", organizationId: "other" };
    await expect(getProjectUsageHistory(ctx, "p1", {})).rejects.toThrow();
  });

  it("returns empty for an inverted window rather than looping forever", async () => {
    const r = await getProjectUsageHistory(ctx, "p1", { from: winTo, to: winFrom });
    expect(r.buckets).toEqual([]);
  });
});
