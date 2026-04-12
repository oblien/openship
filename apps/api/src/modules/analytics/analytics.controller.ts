/**
 * Analytics controller — handlers for analytics + usage + stats endpoints.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserId, param } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { repos } from "@repo/db";
import * as analyticsService from "./analytics.service";
import { fetchMgmt } from "../../lib/project-analytics";
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

// ─── Server analytics (OpenResty scraped data) ───────────────────────────────

/**
 * GET /analytics/server/:serverId — persisted minute-bucket analytics.
 * Query: ?domain=&from=&to= (ISO timestamps or epoch minutes)
 */
export async function serverAnalytics(c: Context) {
  const serverId = param(c, "serverId");
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param is required" }, 400);

  const now = Math.floor(Date.now() / 60_000);
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  const fromMinute = fromParam
    ? (fromParam.includes("-") ? Math.floor(new Date(fromParam).getTime() / 60_000) : Number(fromParam))
    : now - 60;
  const toMinute = toParam
    ? (toParam.includes("-") ? Math.floor(new Date(toParam).getTime() / 60_000) : Number(toParam))
    : now;

  const buckets = await repos.analytics.queryBuckets({
    serverId,
    domain,
    fromMinute,
    toMinute,
  });

  return c.json({ data: buckets });
}

/**
 * GET /analytics/server/:serverId/geo — daily geo aggregates from DB.
 * Query: ?domain=&day=YYYYMMDD
 */
export async function serverGeo(c: Context) {
  const serverId = param(c, "serverId");
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param is required" }, 400);

  const day = c.req.query("day") ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const geo = await repos.analytics.queryGeo({ serverId, domain, day });
  return c.json({ data: geo ?? { countries: {} } });
}

/**
 * GET /analytics/server/:serverId/live — proxy live analytics from the
 * management API on the server (via SSH). Returns real-time data that
 * hasn't been scraped to DB yet.
 * Query: ?domain=
 */
export async function serverAnalyticsLive(c: Context) {
  const serverId = param(c, "serverId");
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param is required" }, 400);

  const data = await fetchMgmt(serverId, `/analytics/totals?domain=${encodeURIComponent(domain)}`);
  if (!data) {
    return c.json({ error: "Failed to reach server management API" }, 502);
  }
  return c.json({ data });
}
