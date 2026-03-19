/**
 * Analytics controller — handlers for analytics + usage + stats endpoints.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserId } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { repos } from "@repo/db";
import * as analyticsService from "./analytics.service";
import type { TAnalyticsQuery, TUsageQuery, TUsageStreamQuery } from "./analytics.schema";

// ─── Request analytics ───────────────────────────────────────────────────────

/** GET /analytics — cumulative summary */
export async function summary(c: Context) {
  const userId = getUserId(c);
  const { projectId } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await analyticsService.getAnalyticsSummary(projectId, userId);
  return c.json({ data });
}

/** GET /analytics/periods — time-series periods */
export async function periods(c: Context) {
  const userId = getUserId(c);
  const { projectId, from, to } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await analyticsService.getAnalyticsPeriods(projectId, userId, from, to);
  return c.json({ data });
}

// ─── Deployment stats ────────────────────────────────────────────────────────

/** GET /analytics/deployments — deployment success/fail/avg build stats */
export async function deploymentStats(c: Context) {
  const userId = getUserId(c);
  const { projectId } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await analyticsService.getDeploymentStats(projectId, userId);
  return c.json({ data });
}

// ─── Resource usage ──────────────────────────────────────────────────────────

/** GET /analytics/usage — current container resource usage */
export async function usage(c: Context) {
  const userId = getUserId(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const data = await analyticsService.getContainerUsage(projectId, userId);
  return c.json({ data });
}

/** GET /analytics/container — container info (status, IP, uptime) */
export async function containerInfo(c: Context) {
  const userId = getUserId(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const data = await analyticsService.getContainerInfo(projectId, userId);
  return c.json({ data });
}

/** GET /analytics/usage/stream — SSE stream of real-time resource usage */
export async function usageStream(c: Context) {
  const userId = getUserId(c);
  const { projectId } = c.req.query() as unknown as TUsageStreamQuery;

  // Verify project access
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    return c.json({ error: "Project not found" }, 404);
  }

  if (!project.activeDeploymentId) {
    return c.json({ error: "No active deployment" }, 404);
  }

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep?.containerId) {
    return c.json({ error: "No active container" }, 404);
  }

  const runtime = await resolveDeploymentRuntime(dep);

  return streamSSE(c, async (sseStream) => {
    const intervalMs = 5_000; // 5 seconds
    let running = true;

    sseStream.onAbort(() => { running = false; });

    while (running) {
      try {
        const stats = await runtime.getUsage(dep.containerId!);
        await sseStream.writeSSE({
          event: "usage",
          data: JSON.stringify({ timestamp: new Date().toISOString(), ...stats }),
        });
      } catch {
        await sseStream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Failed to fetch usage" }),
        });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  });
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/** GET /analytics/dashboard — overview stats for user's dashboard home */
export async function dashboard(c: Context) {
  const userId = getUserId(c);
  const data = await analyticsService.getDashboardStats(userId);
  return c.json({ data });
}
