/**
 * Fixtures for the Monitoring layout preview (`/dev/monitoring`).
 *
 * These exist because the tab could not be LOOKED AT without a control plane, a
 * deployed compose project, and days of real traffic — so two rounds of it shipped on
 * nothing but a typecheck, and the layout problems only surfaced when someone finally
 * opened it.
 *
 * Deliberately not "nice" data. Each fixture carries the shapes that break layouts:
 * a heavily skewed country distribution (real traffic is one country and a long tail),
 * a memory ramp with a gap in it, a service that's crash-looping, a stopped service
 * with no numbers to show, 5xx in the response mix, and long paths that must truncate.
 */

import type { ProjectUsage } from "@/hooks/useProjectUsageStream";
import type { AnalyticsData, AnalyticsGeoResponse } from "@/hooks/useProjectEndpoints";
import type { UsageHistoryBucket } from "./ResourceHistoryChart";

const NOW_MIN = Math.floor(Date.now() / 60_000);
/** Floor to a 5-minute bucket, matching what the sampler writes. */
const bucket = (offsetFromNow: number) =>
  Math.floor((NOW_MIN + offsetFromNow) / 5) * 5;

// ─── Resource history ────────────────────────────────────────────────────────

/**
 * 24h of 5-minute buckets with three things worth seeing rendered:
 *   - a memory ramp (the "was it climbing before the OOM" case)
 *   - a CPU spike partway through
 *   - a GAP where the host was unreachable, which must break the line rather than
 *     dive to zero
 */
export function mockHistoryBuckets(): UsageHistoryBucket[] {
  const out: UsageHistoryBucket[] = [];
  const count = 288; // 24h at 5-minute resolution
  for (let i = count; i >= 0; i--) {
    const minute = bucket(-i * 5);
    const progress = (count - i) / count;

    // Sampler was down for ~50 minutes, a third of the way in.
    const inGap = progress > 0.32 && progress < 0.39;
    if (inGap) {
      out.push({
        minute,
        cpuPercent: 0,
        memoryMb: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        hasData: false,
      });
      continue;
    }

    // Memory climbs steadily then drops — a restart reclaiming it.
    const restarted = progress > 0.78;
    const memBase = restarted ? 180 : 180 + progress * 520;
    // CPU is spiky, with a sustained burst around the two-thirds mark.
    const burst = progress > 0.6 && progress < 0.68 ? 140 : 0;
    const jitter = Math.sin(i * 0.7) * 9 + Math.sin(i * 2.3) * 4;

    out.push({
      minute,
      cpuPercent: Math.max(1, 18 + jitter + burst),
      memoryMb: Math.max(60, memBase + Math.sin(i * 0.4) * 22),
      networkRxBytes: Math.round(400_000 + Math.abs(Math.sin(i * 0.9)) * 2_600_000),
      networkTxBytes: Math.round(150_000 + Math.abs(Math.cos(i * 1.1)) * 900_000),
      hasData: true,
    });
  }
  return out;
}

// ─── Live usage ──────────────────────────────────────────────────────────────

export const MOCK_SERVICES = [
  { serviceKey: "sv-web", name: "web" },
  { serviceKey: "sv-api", name: "api" },
  { serviceKey: "sv-postgres", name: "postgres" },
  { serviceKey: "sv-redis", name: "redis" },
  { serviceKey: "sv-worker", name: "worker" },
];

/** A compose stack mid-incident: one crash-looping, one stopped, three healthy. */
export const mockComposeUsage: ProjectUsage = {
  supported: true,
  overall: {
    cpuPercent: 63.4,
    memoryMb: 1487.2,
    diskMb: 8241.5,
    networkRxBytes: 4_182_000_000,
    networkTxBytes: 1_094_000_000,
  },
  services: [
    {
      serviceId: "sv-web",
      name: "web",
      containerId: "c-web",
      status: "running",
      usage: { cpuPercent: 21.7, memoryMb: 412.3, diskMb: 2100, networkRxBytes: 2_100_000_000, networkTxBytes: 640_000_000 },
    },
    {
      serviceId: "sv-api",
      name: "api",
      containerId: "c-api",
      status: "running",
      usage: { cpuPercent: 33.1, memoryMb: 618.9, diskMb: 3400, networkRxBytes: 1_700_000_000, networkTxBytes: 380_000_000 },
    },
    {
      serviceId: "sv-postgres",
      name: "postgres",
      containerId: "c-pg",
      status: "running",
      usage: { cpuPercent: 8.6, memoryMb: 456.0, diskMb: 2741.5, networkRxBytes: 382_000_000, networkTxBytes: 74_000_000 },
    },
    // Crash-looping: status carries the signal, the numbers are deliberately absent
    // because a container mid-restart has none worth plotting.
    { serviceId: "sv-worker", name: "worker", containerId: "c-worker", status: "restarting", usage: null },
    // Stopped: dashes, never zeros — zero CPU is a real reading.
    { serviceId: "sv-redis", name: "redis", containerId: null, status: "stopped", usage: null },
  ],
  capacity: { cpuCores: 4, memoryMb: 8192 },
  timestamp: new Date().toISOString(),
};

/** A single-container app: one workload, so no scope tabs and no dots. */
export const mockSingleUsage: ProjectUsage = {
  supported: true,
  overall: {
    cpuPercent: 12.4,
    memoryMb: 284.1,
    diskMb: 940,
    networkRxBytes: 820_000_000,
    networkTxBytes: 210_000_000,
  },
  services: [
    {
      serviceId: null,
      name: "my-app",
      containerId: "c-app",
      status: "running",
      usage: { cpuPercent: 12.4, memoryMb: 284.1, diskMb: 940, networkRxBytes: 820_000_000, networkTxBytes: 210_000_000 },
    },
  ],
  capacity: { cpuCores: 2, memoryMb: 4096 },
  timestamp: new Date().toISOString(),
};

/**
 * A static site. No container exists — the shared edge serves it from a volume — so
 * there is nothing to measure and the whole resource block should VANISH rather than
 * render four zeroes.
 */
export const mockStaticUsage: ProjectUsage = {
  supported: true,
  overall: { cpuPercent: 0, memoryMb: 0, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 },
  services: [],
  capacity: { cpuCores: 4, memoryMb: 8192 },
  timestamp: new Date().toISOString(),
};

// ─── Geo / traffic ───────────────────────────────────────────────────────────

/**
 * Real traffic is heavily skewed: one dominant country, a few mid-sized, and a long
 * tail of single-digit ones. A flat distribution would make the choropleth's opacity
 * ramp and the donut both look better than they will in practice.
 */
const COUNTRY_COUNTS: Array<[string, number]> = [
  ["US", 48210], ["DE", 12408], ["GB", 9877], ["IN", 7321], ["FR", 5104],
  ["BR", 4210], ["CA", 3877], ["NL", 3012], ["AU", 2610], ["JP", 2104],
  ["ES", 1880], ["IT", 1640], ["PL", 1204], ["SE", 980], ["TR", 870],
  ["MX", 812], ["ZA", 640], ["SG", 588], ["AE", 470], ["KR", 401],
  ["NG", 388], ["AR", 302], ["ID", 288], ["CH", 210], ["NO", 188],
  ["IE", 140], ["NZ", 120], ["PT", 98], ["FI", 76], ["DK", 61],
  ["CZ", 44], ["RO", 31], ["CL", 22], ["KE", 14], ["IS", 6],
];

export function mockGeo(): AnalyticsGeoResponse {
  const total = COUNTRY_COUNTS.reduce((s, [, n]) => s + n, 0);
  return {
    total,
    countries: COUNTRY_COUNTS.map(([code, count]) => ({
      code,
      count,
      pct: Math.round((count / total) * 1000) / 10,
    })),
    visitorDays: 21408,
    peakDayVisitors: 4192,
    topPaths: [
      { path: "/", count: 38210 },
      { path: "/api/v1/orders/:id", count: 12904 },
      { path: "/dashboard", count: 8712 },
      { path: "/api/v1/users/:id/subscriptions/:id/invoices", count: 4108 },
      { path: "/pricing", count: 3204 },
      { path: "/docs/getting-started/installation", count: 2108 },
      { path: "/login", count: 1877 },
      { path: "other", count: 1204 },
    ],
    // A realistic spread, including nginx's `0` (client vanished before a response) so the
    // unclassified line is exercised by the preview and not only by tests.
    statuses: { "200": 82104, "204": 4210, "301": 2108, "304": 8712, "404": 1877, "429": 204, "500": 88, "502": 41, "503": 12, "0": 63 },
    geoAvailable: true,
    // The preview shows the card populated; the off state has its own variant below.
    pathsEnabled: true,
    approximate: false,
    source: "self-hosted",
  };
}

/** The edge can't resolve countries — the advisory path, not an empty map. */
export function mockGeoUnavailable(): AnalyticsGeoResponse {
  return { ...mockGeo(), countries: [], total: 0, geoAvailable: false };
}

// ─── Named variants ──────────────────────────────────────────────────────────

export type MockVariant = "compose" | "single" | "static" | "no-geo";

export interface MockBundle {
  analytics: AnalyticsData | null;
  geo: AnalyticsGeoResponse | null;
  usage: ProjectUsage | null;
  history: {
    buckets: UsageHistoryBucket[];
    services: Array<{ serviceKey: string; name: string }>;
    granularityMinutes: number;
  } | null;
}

/**
 * One entry per state that is awkward to reproduce on demand — which is why none of
 * them got reviewed until they were wired to a query param.
 *
 * Functions, not constants: the history buckets are anchored to `Date.now()`, so a
 * module-level constant would drift stale the longer a dev server stays up.
 */
export const MOCK_VARIANTS: Record<MockVariant, () => MockBundle> = {
  /** 5 services, one crash-looping, one stopped, history with a ramp and a gap. */
  compose: () => ({
    analytics: mockAnalytics(),
    geo: mockGeo(),
    usage: mockComposeUsage,
    history: { buckets: mockHistoryBuckets(), services: MOCK_SERVICES, granularityMinutes: 5 },
  }),
  /** One container: no scope tabs, no per-service dots, no scope label. */
  single: () => ({
    analytics: mockAnalytics(),
    geo: mockGeo(),
    usage: mockSingleUsage,
    history: { buckets: mockHistoryBuckets(), services: [], granularityMinutes: 5 },
  }),
  /** No container at all — the resource block must be ABSENT, traffic must remain. */
  static: () => ({
    analytics: mockAnalytics(),
    geo: mockGeo(),
    usage: mockStaticUsage,
    history: { buckets: [], services: [], granularityMinutes: 5 },
  }),
  /** Edge can't resolve countries: advisory, not a grey map next to an apology. */
  "no-geo": () => ({
    analytics: mockAnalytics(),
    geo: mockGeoUnavailable(),
    usage: mockComposeUsage,
    history: { buckets: mockHistoryBuckets(), services: MOCK_SERVICES, granularityMinutes: 5 },
  }),
};

export function mockAnalytics(): AnalyticsData {
  const now = Date.now();
  const totalRequests = 99_356;
  return {
    success: true,
    domain: "app.example.com",
    summary: {
      totalRequests,
      uniqueIPs: 61_204,
      pageRequests: 61_204,
      uniqueVisitors: null, // self-hosted: the real figure comes from geo
      uniqueRequests: totalRequests,
      totalIPs: totalRequests,
      uniqueIPsPercentage: "61.6",
      firstRequest: new Date(now - 7 * 86_400_000).toISOString(),
      lastRequest: new Date(now).toISOString(),
      timeRangeHours: 168,
      avgRequestsPerHour: 591,
    },
    performance: {
      avgResponseTime: 0.0842,
      avgResponseTimeMs: 84.2,
      totalResponseTime: 84.2 * totalRequests,
      minResponseTime: "84ms",
      maxResponseTime: "84ms",
    },
    bandwidth: {
      totalIn: 1_284_000_000,
      totalOut: 18_402_000_000,
      totalInFormatted: "1.20 GB",
      totalOutFormatted: "17.14 GB",
      avgRequestSize: 12_924,
      avgResponseSize: 185_204,
    },
    topPaths: [],
    trafficByHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      // A believable diurnal curve, not a flat line — a flat chart hides whether the
      // axis scaling is right.
      requests: Math.round(
        1200 + Math.sin(((hour - 4) / 24) * Math.PI * 2) * 900 + Math.random() * 180,
      ),
    })),
    limited: false,
  };
}
