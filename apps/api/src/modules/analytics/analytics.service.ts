/**
 * Analytics service — request analytics, resource usage, and deployment stats.
 *
 * Data flow:
 *   - OpenResty shared-dict accumulates counters in real-time (log_by_lua)
 *   - Scraper (analytics-scraper.ts) flushes completed minutes from OpenResty → DB
 *     via POST /analytics/flush (read + delete), every 5 min
 *   - DB has all flushed history, OpenResty has only unflushed recent data
 *   - Reading always combines both: DB (flushed archive) + live (unflushed tail)
 *   - No overlap, no duplication, no data loss on OpenResty restart
 *
 * The runtime integration is behind the Platform interface, so this
 * service works identically with Docker (self-hosted) and Oblien (cloud).
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import type { ResourceUsage } from "@repo/adapters";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { resolveProjectTracking, fetchMgmt } from "../../lib/project-analytics";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MgmtAnalyticsBucket {
  minute: number;
  requests: number;
  unique_requests: number;
  bandwidth_in: number;
  bandwidth_out: number;
  response_time: number;
}

function getBucketArray(value: unknown): MgmtAnalyticsBucket[] {
  return Array.isArray(value) ? value as MgmtAnalyticsBucket[] : [];
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

/** Convert a DB row to the unified bucket shape. */
function toMgmtBucket(b: { minute: number; requests: number; uniqueRequests: number; bandwidthIn: number; bandwidthOut: number; responseTime: number }): MgmtAnalyticsBucket {
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
function summariseBuckets(buckets: MgmtAnalyticsBucket[], lastUpdated: string): AnalyticsSummary {
  const totalReqs = buckets.reduce((s, b) => s + b.requests, 0);
  const totalUnique = buckets.reduce((s, b) => s + b.unique_requests, 0);
  const totalIn = buckets.reduce((s, b) => s + b.bandwidth_in, 0);
  const totalOut = buckets.reduce((s, b) => s + b.bandwidth_out, 0);
  const avgRt = buckets.reduce((s, b) => s + b.response_time, 0) / buckets.length;
  return {
    totalRequests: totalReqs,
    uniqueVisitors: totalUnique,
    bandwidthIn: totalIn,
    bandwidthOut: totalOut,
    avgResponseTimeMs: Math.round(avgRt * 1000),
    lastUpdated,
  };
}

function buildHourlyPeriods(
  buckets: MgmtAnalyticsBucket[],
  fromMinute: number,
  toMinute: number,
): AnalyticsPeriod[] {
  const hourly = new Map<number, {
    requests: number;
    uniqueVisitors: number;
    bandwidthIn: number;
    bandwidthOut: number;
    responseTimeTotal: number;
    bucketCount: number;
  }>();

  for (const bucket of buckets) {
    const hourKey = Math.floor(bucket.minute / 60);
    const current = hourly.get(hourKey) ?? {
      requests: 0,
      uniqueVisitors: 0,
      bandwidthIn: 0,
      bandwidthOut: 0,
      responseTimeTotal: 0,
      bucketCount: 0,
    };

    current.requests += bucket.requests;
    current.uniqueVisitors += bucket.unique_requests;
    current.bandwidthIn += bucket.bandwidth_in;
    current.bandwidthOut += bucket.bandwidth_out;
    current.responseTimeTotal += bucket.response_time;
    current.bucketCount += 1;
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
      avgResponseTimeMs: current && current.bucketCount > 0
        ? Math.round((current.responseTimeTotal / current.bucketCount) * 1000)
        : 0,
      topPaths: [],
      trafficByHour: {},
    });
  }

  return periods;
}

const EMPTY_SUMMARY: AnalyticsSummary = {
  totalRequests: 0,
  uniqueVisitors: 0,
  bandwidthIn: 0,
  bandwidthOut: 0,
  avgResponseTimeMs: 0,
  lastUpdated: null,
};

export interface AnalyticsSummary {
  /** Total requests (all time) */
  totalRequests: number;
  /** Total unique visitors */
  uniqueVisitors: number;
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
 * Always combines both sources (no overlap thanks to scraper flush):
 *   - DB: all flushed history
 *   - Live OpenResty: unflushed recent tail (since last scraper run)
 */
export async function getAnalyticsSummary(
  projectId: string,
  userId: string,
): Promise<AnalyticsSummary> {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  const tracking = await resolveProjectTracking(projectId);
  if (!tracking) {
    return EMPTY_SUMMARY;
  }

  const { domain, serverId } = tracking;
  const now = Math.floor(Date.now() / 60_000);

  // DB: flushed archive (last 24h of persisted data)
  const dbBuckets = await repos.analytics.recentBuckets({ serverId, domain, limit: 1440 });

  // Live OpenResty: unflushed tail (since last scraper flush)
  // The scraper flushes up to `now - 1` so live always has at least the current minute
  const lastFlushed = dbBuckets.length > 0 ? dbBuckets[0]!.minute : now - 1440;
  const liveBuckets = await fetchLiveBuckets(serverId, domain, lastFlushed + 1, now);

  // Combine both sources
  const allBuckets: MgmtAnalyticsBucket[] = [
    ...dbBuckets.map(toMgmtBucket),
    ...liveBuckets,
  ];

  if (allBuckets.length === 0) return EMPTY_SUMMARY;

  const lastUpdated = liveBuckets.length > 0
    ? new Date().toISOString()
    : dbBuckets[0]!.createdAt.toISOString();

  return summariseBuckets(allBuckets, lastUpdated);
}

// ─── Analytics periods ───────────────────────────────────────────────────────

/**
 * Get aggregated analytics periods for a date range.
 *
 * Always combines both sources (no overlap thanks to scraper flush):
 *   - DB: flushed history for the requested range
 *   - Live OpenResty: unflushed tail appended after last DB minute
 * Grouped into hourly periods for charting.
 */
export async function getAnalyticsPeriods(
  projectId: string,
  userId: string,
  from?: string,
  to?: string,
): Promise<AnalyticsPeriod[]> {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  const tracking = await resolveProjectTracking(projectId);
  if (!tracking) return [];
  const { domain, serverId } = tracking;

  const now = Math.floor(Date.now() / 60_000);
  const fromMinute = from ? Math.floor(new Date(from).getTime() / 60_000) : now - 1440;
  const toMinute = to ? Math.floor(new Date(to).getTime() / 60_000) : now;

  // DB: flushed archive for the requested range
  const dbBuckets = await repos.analytics.queryBuckets({ serverId, domain, fromMinute, toMinute });

  // Live OpenResty: unflushed tail (starts after last DB minute)
  const lastDbMinute = dbBuckets.length > 0
    ? Math.max(...dbBuckets.map(b => b.minute))
    : fromMinute - 1;
  const liveFrom = Math.max(lastDbMinute + 1, fromMinute);
  const liveBuckets = liveFrom <= toMinute
    ? await fetchLiveBuckets(serverId, domain, liveFrom, toMinute)
    : [];

  // Combine both sources
  const allBuckets: MgmtAnalyticsBucket[] = [
    ...dbBuckets.map(toMgmtBucket),
    ...liveBuckets,
  ];

  if (allBuckets.length === 0) return [];

  return buildHourlyPeriods(allBuckets, fromMinute, toMinute);
}

// ─── Deployment stats ────────────────────────────────────────────────────────

/**
 * Get deployment statistics for a project:
 *   - Total / success / failed counts
 *   - Average build duration
 *   - Daily deployments for the last 30 days
 */
export async function getDeploymentStats(
  projectId: string,
  userId: string,
  days = 30,
): Promise<DeploymentStats> {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
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
  const successDeps = deployments.filter(
    (d) => d.status === "ready" && d.buildDurationMs,
  );
  const avgBuild =
    successDeps.length > 0
      ? Math.round(
          successDeps.reduce((sum, d) => sum + (d.buildDurationMs ?? 0), 0) /
            successDeps.length,
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

/**
 * Get current resource usage for a project's active container.
 * Returns null if no active deployment.
 */
export async function getContainerUsage(
  projectId: string,
  userId: string,
): Promise<ResourceUsage | null> {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  if (!project.activeDeploymentId) return null;

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep?.containerId) return null;

  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getUsage(dep.containerId);
}

/**
 * Get container info (status, IP, uptime, current usage).
 */
export async function getContainerInfo(
  projectId: string,
  userId: string,
) {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  if (!project.activeDeploymentId) return null;

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep?.containerId) return null;

  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getContainerInfo(dep.containerId);
}

// ─── Dashboard home stats ────────────────────────────────────────────────────

/**
 * Get overview stats for the user's dashboard home.
 */
export async function getDashboardStats(userId: string) {
  const { rows: projects, total: totalProjects } = await repos.project.listByUser(
    userId,
    { page: 1, perPage: 10_000 },
  );

  const activeProjects = projects.filter((p) => p.activeDeploymentId).length;

  // Aggregate deployment counts across all projects
  let totalDeployments = 0;
  let failedDeployments = 0;
  let successDeployments = 0;

  for (const p of projects.slice(0, 50)) {
    // Limit to 50 projects for perf
    const { rows } = await repos.deployment.listByProject(p.id, { page: 1, perPage: 100 });
    totalDeployments += rows.length;
    failedDeployments += rows.filter((d) => d.status === "failed").length;
    successDeployments += rows.filter((d) => d.status === "ready").length;
  }

  return {
    projects: { total: totalProjects, active: activeProjects },
    deployments: {
      total: totalDeployments,
      success: successDeployments,
      failed: failedDeployments,
      pending: totalDeployments - successDeployments - failedDeployments,
    },
  };
}
