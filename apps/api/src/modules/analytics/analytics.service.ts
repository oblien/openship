/**
 * Analytics service — request analytics, resource usage, and deployment stats.
 *
 * Data sources:
 *   - DB:      Historical aggregated periods, cumulative counters
 *   - Redis:   Live request logs + counters (populated by the reverse-proxy)
 *   - Adapter: Real-time container resource usage (CPU, memory, network)
 *
 * The runtime integration is behind the Platform interface, so this
 * service works identically with Docker (self-hosted) and Oblien (cloud).
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
import type { ResourceUsage } from "@repo/adapters";

// ─── Types ───────────────────────────────────────────────────────────────────

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
 * Returns totals from DB + optional live increment from Redis.
 */
export async function getAnalyticsSummary(
  projectId: string,
  userId: string,
): Promise<AnalyticsSummary> {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  // TODO: Fetch from analytics_summary table once analytics flush is wired
  // For now, return zero-state
  return {
    totalRequests: 0,
    uniqueVisitors: 0,
    bandwidthIn: 0,
    bandwidthOut: 0,
    avgResponseTimeMs: 0,
    lastUpdated: null,
  };
}

// ─── Analytics periods ───────────────────────────────────────────────────────

/**
 * Get aggregated analytics periods for a date range.
 * Used for charts and detailed reports.
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

  // TODO: Fetch from analytics_period table once analytics flush is wired
  return [];
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

  const { runtime } = platform();
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

  const { runtime } = platform();
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
