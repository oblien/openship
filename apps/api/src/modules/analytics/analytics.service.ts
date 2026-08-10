/**
 * Analytics service - request analytics, resource usage, and deployment stats.
 *
 * Data flow:
 *   - OpenResty shared-dict accumulates counters in real-time (log_by_lua)
 *   - Scraper (analytics-scraper.ts) flushes completed minutes from OpenResty → DB
 *     via POST /analytics/collect (read + delete, one call for the whole box),
 *     driven by the `analytics:scrape` system job and by analytics reads
 *   - DB has all flushed history, OpenResty has only unflushed recent data
 *   - Reading always combines both: DB (flushed archive) + live (unflushed tail)
 *   - No overlap, no duplication, no data loss on OpenResty restart
 *
 * Source selection is deployment-mode aware:
 *   - SaaS / OpenShip Cloud: Oblien analytics is the source of truth
 *   - Self-hosted: DB archive + live OpenResty tail are merged
 */

import { repos } from "@repo/db";
import { NotFoundError, AppError, safeErrorMessage } from "@repo/core";
import type { ResourceUsage } from "@repo/adapters";
import { resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import {
  resolveProjectTrafficSources,
  fetchMgmt,
} from "../../lib/project-analytics";
import { getAdminOblienClient } from "../../lib/oblien-user-client";
import { cloudClient } from "../../lib/cloud/client";
import type { RequestContext } from "../../lib/request-context";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CloudAnalyticsBucket {
  timestamp: number;
  requests: number;
  bandwidth_in: number;
  bandwidth_out: number;
  response_time_sum: number;
  unique_visitors: number;
}

interface CloudTimeseriesResponse {
  data: CloudAnalyticsBucket[];
  meta?: { to?: number };
}

interface MgmtAnalyticsBucket {
  minute: number;
  requests: number;
  unique_requests: number;
  bandwidth_in: number;
  bandwidth_out: number;
  response_time: number;
}

function getBucketArray(value: unknown): MgmtAnalyticsBucket[] {
  return Array.isArray(value) ? (value as MgmtAnalyticsBucket[]) : [];
}

async function fetchLiveBuckets(
  serverId: string,
  domain: string,
  fromMinute: number,
  toMinute: number,
): Promise<MgmtAnalyticsBucket[]> {
  const result = await fetchMgmt<{ buckets?: MgmtAnalyticsBucket[] }>(
    serverId,
    `/analytics?domain=${encodeURIComponent(domain)}&from=${fromMinute}&to=${toMinute}`,
  );
  return getBucketArray(result?.buckets);
}

/**
 * The live OpenResty tail is only the last few UNFLUSHED minutes — the DB
 * already holds every flushed minute (the real snapshot). The tail is fetched
 * over an SSH tunnel to the edge, which is slow/unreachable when the server is
 * remote (desktop mode) — and letting it block times out the WHOLE overview
 * (the "analytics request timed out, works after a huge time" symptom). Cap it
 * hard and fall back to the DB archive; a few missing seconds of live data is a
 * fair trade for an overview that always returns fast. Best-effort, never throws.
 */
const LIVE_TAIL_TIMEOUT_MS = 3500;

async function fetchLiveBucketsBounded(
  serverId: string,
  domain: string,
  fromMinute: number,
  toMinute: number,
): Promise<MgmtAnalyticsBucket[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<MgmtAnalyticsBucket[]>((resolve) => {
    timer = setTimeout(() => resolve([]), LIVE_TAIL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetchLiveBuckets(serverId, domain, fromMinute, toMinute).catch(() => []),
      capped,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Convert a DB row to the unified bucket shape. */
function toMgmtBucket(b: {
  minute: number;
  requests: number;
  uniqueRequests: number;
  bandwidthIn: number;
  bandwidthOut: number;
  responseTime: number;
}): MgmtAnalyticsBucket {
  return {
    minute: b.minute,
    requests: b.requests,
    unique_requests: b.uniqueRequests,
    bandwidth_in: b.bandwidthIn,
    bandwidth_out: b.bandwidthOut,
    response_time: b.responseTime,
  };
}

/** Reduce an array of buckets into a summary. */
export function summariseBuckets(
  buckets: MgmtAnalyticsBucket[],
  lastUpdated: string,
): AnalyticsSummary {
  const totalReqs = buckets.reduce((s, b) => s + b.requests, 0);
  const totalUnique = buckets.reduce((s, b) => s + b.unique_requests, 0);
  const totalIn = buckets.reduce((s, b) => s + b.bandwidth_in, 0);
  const totalOut = buckets.reduce((s, b) => s + b.bandwidth_out, 0);
  const weightedRt = buckets.reduce((s, b) => s + b.response_time * b.requests, 0);
  return {
    totalRequests: totalReqs,
    pageRequests: totalUnique,
    uniqueVisitors: null,
    bandwidthIn: totalIn,
    bandwidthOut: totalOut,
    avgResponseTimeMs: totalReqs > 0 ? Math.round((weightedRt / totalReqs) * 1000) : 0,
    lastUpdated,
  };
}

function summariseCloudBuckets(
  buckets: CloudAnalyticsBucket[],
  lastUpdated: string,
): AnalyticsSummary {
  const totalReqs = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  const totalUnique = buckets.reduce((sum, bucket) => sum + bucket.unique_visitors, 0);
  const totalIn = buckets.reduce((sum, bucket) => sum + bucket.bandwidth_in, 0);
  const totalOut = buckets.reduce((sum, bucket) => sum + bucket.bandwidth_out, 0);
  const totalResponseTime = buckets.reduce((sum, bucket) => sum + bucket.response_time_sum, 0);

  return {
    totalRequests: totalReqs,
    // Oblien exposes distinct visitors but not a non-static request count, so this
    // is the closest honest mapping: page requests are unknown here.
    pageRequests: 0,
    uniqueVisitors: totalUnique,
    bandwidthIn: totalIn,
    bandwidthOut: totalOut,
    avgResponseTimeMs: totalReqs > 0 ? Math.round(totalResponseTime / totalReqs) : 0,
    lastUpdated,
  };
}

export function buildHourlyPeriods(
  buckets: MgmtAnalyticsBucket[],
  fromMinute: number,
  toMinute: number,
): AnalyticsPeriod[] {
  const hourly = new Map<
    number,
    {
      requests: number;
      uniqueVisitors: number;
      bandwidthIn: number;
      bandwidthOut: number;
      responseTimeWeighted: number;
    }
  >();

  for (const bucket of buckets) {
    const hourKey = Math.floor(bucket.minute / 60);
    const current = hourly.get(hourKey) ?? {
      requests: 0,
      uniqueVisitors: 0,
      bandwidthIn: 0,
      bandwidthOut: 0,
      responseTimeWeighted: 0,
    };

    current.requests += bucket.requests;
    current.uniqueVisitors += bucket.unique_requests;
    current.bandwidthIn += bucket.bandwidth_in;
    current.bandwidthOut += bucket.bandwidth_out;
    current.responseTimeWeighted += bucket.response_time * bucket.requests;
    hourly.set(hourKey, current);
  }

  const periods: AnalyticsPeriod[] = [];
  const startHour = Math.floor(fromMinute / 60);
  const endHour = Math.floor(toMinute / 60);

  for (let hourKey = startHour; hourKey <= endHour; hourKey += 1) {
    const hourStart = new Date(hourKey * 60 * 60_000);
    const hourEnd = new Date((hourKey + 1) * 60 * 60_000);
    const current = hourly.get(hourKey);

    periods.push({
      from: hourStart.toISOString(),
      to: hourEnd.toISOString(),
      requests: current?.requests ?? 0,
      uniqueVisitors: current?.uniqueVisitors ?? 0,
      bandwidthIn: current?.bandwidthIn ?? 0,
      bandwidthOut: current?.bandwidthOut ?? 0,
      avgResponseTimeMs:
        current && current.requests > 0
          ? Math.round((current.responseTimeWeighted / current.requests) * 1000)
          : 0,
      topPaths: [],
      trafficByHour: {},
    });
  }

  return periods;
}

function buildCloudHourlyPeriods(
  buckets: CloudAnalyticsBucket[],
  fromMs: number,
  toMs: number,
): AnalyticsPeriod[] {
  const byHour = new Map<number, CloudAnalyticsBucket>();

  for (const bucket of buckets) {
    const current = byHour.get(bucket.timestamp);
    if (!current) {
      byHour.set(bucket.timestamp, { ...bucket });
      continue;
    }

    current.requests += bucket.requests;
    current.bandwidth_in += bucket.bandwidth_in;
    current.bandwidth_out += bucket.bandwidth_out;
    current.response_time_sum += bucket.response_time_sum;
    current.unique_visitors += bucket.unique_visitors;
  }

  const periods: AnalyticsPeriod[] = [];
  const startHour = Math.floor(fromMs / 3_600_000);
  const endHour = Math.floor(toMs / 3_600_000);

  for (let hourKey = startHour; hourKey <= endHour; hourKey += 1) {
    const bucketStartMs = hourKey * 3_600_000;
    const bucket = byHour.get(Math.floor(bucketStartMs / 1000));

    periods.push({
      from: new Date(bucketStartMs).toISOString(),
      to: new Date(bucketStartMs + 3_600_000).toISOString(),
      requests: bucket?.requests ?? 0,
      uniqueVisitors: bucket?.unique_visitors ?? 0,
      bandwidthIn: bucket?.bandwidth_in ?? 0,
      bandwidthOut: bucket?.bandwidth_out ?? 0,
      avgResponseTimeMs:
        bucket && bucket.requests > 0 ? Math.round(bucket.response_time_sum / bucket.requests) : 0,
      topPaths: [],
      trafficByHour: {},
    });
  }

  return periods;
}

const EMPTY_SUMMARY: AnalyticsSummary = {
  totalRequests: 0,
  pageRequests: 0,
  // 0, not null: this is the summary for a project with a resolvable traffic
  // source that genuinely reported nothing, so "zero visitors" is the true answer
  // rather than "look elsewhere".
  uniqueVisitors: 0,
  bandwidthIn: 0,
  bandwidthOut: 0,
  avgResponseTimeMs: 0,
  lastUpdated: null,
};

/**
 * The Oblien SDK returns `{ success, data: AnalyticsBucket[], meta }`; the cloud
 * PROXY wraps that again as `{ data: <sdkResponse> }`. So the bucket array sits
 * at `.data` (admin-direct) or `.data.data` (cloud-proxied). Reading a fixed
 * depth got the WRAPPER object on the proxied path — which flat-mapped into a
 * single bogus "bucket" whose numeric fields were undefined → NaN → null totals.
 * Walk down nested data/result wrappers to the actual array regardless of depth.
 */
function extractCloudBuckets(result: unknown): CloudAnalyticsBucket[] {
  let node: unknown = result;
  for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as CloudAnalyticsBucket[];
    node = obj.data ?? obj.result;
  }
  return Array.isArray(result) ? (result as CloudAnalyticsBucket[]) : [];
}

/**
 * Surface an EXPLICIT Oblien failure envelope (`{ success: false, … }`) as a
 * thrown error so the caller returns a clean upstream error instead of parsing
 * it to an empty bucket list and rendering a misleading 0/0/0 summary.
 *
 * Deliberately conservative: it throws ONLY on an explicit `success: false`.
 * A genuine success (empty `data` = no traffic) OR any shape without that flag
 * falls through to `extractCloudBuckets` exactly as before — so this can never
 * turn a benign/empty response into a false error, only unmask a declared one.
 * (Thrown transport errors are already handled by the caller's all-failed 502.)
 *
 * Envelope: `{ success, data, meta }`, sometimes wrapped again as `{ data: … }`
 * on the proxied path (same nesting extractCloudBuckets walks).
 */
function assertCloudTimeseriesOk(raw: unknown): void {
  let node: unknown = raw;
  for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    if (obj.success === false) {
      const detail =
        (typeof obj.error === "string" && obj.error) ||
        (typeof obj.message === "string" && obj.message) ||
        "request rejected";
      throw new Error(`Openship Cloud analytics: ${detail}`);
    }
    if (Array.isArray(obj.data)) return; // reached the bucket array — done
    node = obj.data ?? obj.result;
  }
}

async function fetchCloudTimeseries(
  organizationId: string,
  domain: string,
  params: { from: number; to: number; interval: "hour" },
): Promise<CloudTimeseriesResponse | null> {
  // Direct, no caching — always the live source of truth. (Request volume is
  // controlled on the client; see ServerAnalytics fetch dedup.)
  const client = getAdminOblienClient();
  const raw = client
    ? await client.analytics.timeseries(domain, params)
    : await cloudClient({ organizationId }).analytics.timeseries(domain, params);
  // Surface a failed fetch as an error (caller → 502) instead of masking it as
  // an empty summary; only a genuine no-traffic success falls through to [].
  assertCloudTimeseriesOk(raw);
  return { data: extractCloudBuckets(raw) };
}

export interface AnalyticsSummary {
  /** Total requests (all time) */
  totalRequests: number;
  /**
   * Non-static ("page") requests — NOT people. Five page views from one browser
   * count five.
   *
   * This is what the self-hosted edge's `:u` counter has always measured, and it
   * was reported as `uniqueVisitors` and then relabelled "Unique IPs" in the
   * dashboard, which it never was. Named for what it is.
   */
  pageRequests: number;
  /**
   * Genuinely distinct visitors, or null when this source can't tell.
   *
   * Non-null only where the SOURCE does the dedup: Oblien reports
   * `unique_visitors` per bucket. The self-hosted edge dedups per DAY (a salted
   * hash set in shared memory), which doesn't decompose into the minute buckets
   * this summary is built from — so it is null here and the real number comes from
   * `GET /analytics/geo`. Null means "ask elsewhere", never "zero visitors".
   */
  uniqueVisitors: number | null;
  /** Bandwidth in bytes */
  bandwidthIn: number;
  bandwidthOut: number;
  /** Average response time in ms */
  avgResponseTimeMs: number;
  /** Last flush timestamp */
  lastUpdated: string | null;
}

export interface AnalyticsPeriod {
  /** Period start */
  from: string;
  /** Period end */
  to: string;
  requests: number;
  uniqueVisitors: number;
  bandwidthIn: number;
  bandwidthOut: number;
  avgResponseTimeMs: number;
  /**
   * ALWAYS EMPTY, and structurally so — not a stub waiting to be filled.
   *
   * Path counters are aggregated per DAY at the edge, deliberately: per-minute path
   * keys would multiply the analytics zone's cardinality by ~1440 and evict the
   * request counters they annotate. A per-hour period therefore has no path data to
   * carry. Window-level top paths come from `GET /analytics/geo`, which reads the
   * daily rollup; the dashboard reads them from there.
   *
   * Kept on the type so the wire shape is stable for existing consumers.
   */
  topPaths: { path: string; count: number }[];
  trafficByHour: Record<string, number>;
}

export interface DeploymentStats {
  totalDeployments: number;
  successfulDeployments: number;
  failedDeployments: number;
  avgBuildDurationMs: number;
  /** Deployments per day for the last N days */
  dailyCounts: { date: string; total: number; success: number; failed: number }[];
}

export interface ContainerUsageSnapshot {
  timestamp: string;
  cpuPercent: number;
  memoryMb: number;
  diskMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

// ─── Analytics summary ───────────────────────────────────────────────────────

/**
 * Get cumulative analytics summary for a project.
 *
 * SaaS/OpenShip Cloud projects read from Oblien only.
 * Self-hosted projects combine DB history with the live OpenResty tail.
 */
/**
 * Fetch a project's traffic ONCE and derive BOTH the cumulative summary and the
 * hourly periods from the same buckets. The dashboard reads this single endpoint
 * so a project view makes ONE cloud round-trip, instead of the two it used to
 * (separate /summary + /periods each re-fetching the identical timeseries).
 *
 * Cloud projects read from Oblien; self-hosted combine DB history + the live
 * OpenResty tail. `from`/`to` default to the last 24h. No caching — the SaaS is
 * the live source of truth; request volume is controlled on the client.
 */
export async function getAnalyticsOverview(
  ctx: RequestContext,
  projectId: string,
  from?: string,
  to?: string,
  domain?: string,
): Promise<{ summary: AnalyticsSummary; periods: AnalyticsPeriod[] }> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Project", projectId);
  }

  // `domain` scopes to one tracked domain (validated; falls back to the primary
  // when untracked — never fetches an arbitrary cross-tenant host). Without it,
  // aggregate every tracked domain. Both handled by the one resolver.
  const sources = await resolveProjectTrafficSources(projectId, { domain });
  // No resolvable traffic source (no tracked domain / no primary / no server) is
  // a legitimate "nothing to show", NOT an error — keep the honest empty summary
  // so a fresh or domain-less project renders a clean 0-state, not an error.
  if (sources.length === 0) return { summary: EMPTY_SUMMARY, periods: [] };

  if (sources.every((source) => source.kind === "cloud")) {
    const toMs = to ? new Date(to).getTime() : Date.now();
    const fromMs = from ? new Date(from).getTime() : toMs - 24 * 60 * 60 * 1000;
    const params = { from: fromMs, to: toMs, interval: "hour" as const };
    // Do NOT swallow a cloud fetch failure into an empty summary — that made an
    // upstream outage look identical to "no traffic" (zeros with a 200). Settle
    // per-domain: use whatever succeeded, but if EVERY cloud fetch failed,
    // surface a real upstream error so the client can tell "broken" from "idle".
    const settled = await Promise.allSettled(
      sources.map((source) => fetchCloudTimeseries(ctx.organizationId, source.domain, params)),
    );
    const ok = settled.filter(
      (r): r is PromiseFulfilledResult<CloudTimeseriesResponse | null> => r.status === "fulfilled",
    );
    if (ok.length === 0) {
      const reason = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      throw new AppError(
        `Analytics upstream (Openship Cloud) is unavailable${reason ? `: ${safeErrorMessage(reason.reason)}` : ""}`,
        502,
        "ANALYTICS_UPSTREAM_UNAVAILABLE",
      );
    }
    const buckets = ok.flatMap((r) => r.value?.data ?? []);
    // Reached the cloud, but it reported no traffic → genuine empty (200).
    if (buckets.length === 0) return { summary: EMPTY_SUMMARY, periods: [] };
    return {
      summary: summariseCloudBuckets(buckets, new Date(toMs).toISOString()),
      periods: buildCloudHourlyPeriods(buckets, fromMs, toMs),
    };
  }

  const now = Math.floor(Date.now() / 60_000);
  const fromMinute = from ? Math.floor(new Date(from).getTime() / 60_000) : now - 1440;
  const toMinute = to ? Math.floor(new Date(to).getTime() / 60_000) : now;
  const selfHostedSources = sources.filter((source) => source.kind === "self-hosted");
  const bucketSets = await Promise.all(
    selfHostedSources.map(async ({ domain, serverId }) => {
      // DB: flushed archive for the requested range.
      const dbBuckets = await repos.analytics.queryBuckets({ serverId, domain, fromMinute, toMinute });
      // Live OpenResty: unflushed tail (starts after the last persisted minute).
      const lastDbMinute =
        dbBuckets.length > 0 ? Math.max(...dbBuckets.map((b) => b.minute)) : fromMinute - 1;
      const liveFrom = Math.max(lastDbMinute + 1, fromMinute);
      const liveBuckets =
        liveFrom <= toMinute ? await fetchLiveBucketsBounded(serverId, domain, liveFrom, toMinute) : [];
      return [...dbBuckets.map(toMgmtBucket), ...liveBuckets];
    }),
  );
  const allBuckets: MgmtAnalyticsBucket[] = bucketSets.flat();
  if (allBuckets.length === 0) return { summary: EMPTY_SUMMARY, periods: [] };
  return {
    summary: summariseBuckets(allBuckets, new Date().toISOString()),
    periods: buildHourlyPeriods(allBuckets, fromMinute, toMinute),
  };
}

// ─── Deployment stats ────────────────────────────────────────────────────────

/**
 * Get deployment statistics for a project:
 *   - Total / success / failed counts
 *   - Average build duration
 *   - Daily deployments for the last 30 days
 */
export async function getDeploymentStats(
  ctx: RequestContext,
  projectId: string,
  days = 30,
): Promise<DeploymentStats> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Project", projectId);
  }

  // Fetch all deployments for counting
  const { rows: deployments } = await repos.deployment.listByProject(projectId, {
    page: 1,
    perPage: 10_000, // Get all for stats
  });

  const total = deployments.length;
  const success = deployments.filter((d) => d.status === "ready").length;
  const failed = deployments.filter((d) => d.status === "failed").length;

  // Average build duration of successful deployments
  const successDeps = deployments.filter((d) => d.status === "ready" && d.buildDurationMs);
  const avgBuild =
    successDeps.length > 0
      ? Math.round(
          successDeps.reduce((sum, d) => sum + (d.buildDurationMs ?? 0), 0) / successDeps.length,
        )
      : 0;

  // Daily counts for the last N days
  const now = new Date();
  const dailyCounts: DeploymentStats["dailyCounts"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0]!;

    const dayDeps = deployments.filter((d) => {
      const depDate = new Date(d.createdAt).toISOString().split("T")[0];
      return depDate === dateStr;
    });

    dailyCounts.push({
      date: dateStr,
      total: dayDeps.length,
      success: dayDeps.filter((d) => d.status === "ready").length,
      failed: dayDeps.filter((d) => d.status === "failed").length,
    });
  }

  return {
    totalDeployments: total,
    successfulDeployments: success,
    failedDeployments: failed,
    avgBuildDurationMs: avgBuild,
    dailyCounts,
  };
}

// ─── Resource usage (live) ───────────────────────────────────────────────────
//
// `getContainerUsage` used to live here and is GONE, not moved: it read
// `deployment.containerId` alone, which on a compose project is the primary
// service's container, and reported it as the project's usage. Its replacement is
// `modules/monitoring/project-usage.ts`, which covers every service and is the one
// implementation both /analytics/usage and /analytics/resources now share.

/**
 * Container info (status, IP, uptime) for a project's primary container.
 *
 * Genuinely single-container by nature — this describes the deployment's own
 * container, not the stack — so it is not duplicating the usage collector.
 *
 * Uses the READ-ONLY resolver: building a full platform here runs
 * `detectOpenRestyPaths` plus the edge-Lua self-heal inside the provision lock,
 * which is the documented cause of polled reads timing out while containers were
 * up. Caller-facing behaviour is unchanged; only the resolution cost is.
 */
export async function getContainerInfo(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Project", projectId);
  }

  if (!project.activeDeploymentId) return null;

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep?.containerId) return null;

  const { runtime } = await resolveDeploymentRuntimeForRead(dep);
  try {
    return await runtime.getContainerInfo(dep.containerId);
  } finally {
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
  }
}

// ─── Dashboard home stats ────────────────────────────────────────────────────

/**
 * Get overview stats for the dashboard home — scoped to the caller's
 * current organization. Returns counts for projects + deployments in
 * the active org only (not cross-org).
 */
export async function getDashboardStats(ctx: RequestContext) {
  const [projectCounts, deploymentsByStatus] = await Promise.all([
    repos.project.countByOrganization(ctx.organizationId),
    repos.deployment.countByStatusForOrganization(ctx.organizationId),
  ]);

  let totalDeployments = 0;
  for (const count of Object.values(deploymentsByStatus)) totalDeployments += count;
  const successDeployments = deploymentsByStatus["ready"] ?? 0;
  const failedDeployments = deploymentsByStatus["failed"] ?? 0;

  return {
    projects: { total: projectCounts.total, active: projectCounts.active },
    deployments: {
      total: totalDeployments,
      success: successDeployments,
      failed: failedDeployments,
      pending: totalDeployments - successDeployments - failedDeployments,
    },
  };
}
