/**
 * Analytics controller - handlers for analytics + usage + stats endpoints.
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { repos } from "@repo/db";
import * as analyticsService from "./analytics.service";
import { fetchMgmt } from "../../lib/project-analytics";
import { scrapeServerIfStale } from "../system/analytics-scraper";
import type { TAnalyticsQuery, TUsageQuery, TUsageStreamQuery } from "./analytics.schema";

// ─── Request analytics ───────────────────────────────────────────────────────

/** GET /analytics - cumulative summary */
export async function summary(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId, domain } = c.req.query() as unknown as TAnalyticsQuery;
  // Slice the single fetch+compute overview (last 24h) to just its summary.
  const data = (await analyticsService.getAnalyticsOverview(ctx, projectId, undefined, undefined, domain)).summary;
  return c.json({ data });
}

/** GET /analytics/periods - time-series periods */
export async function periods(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId, from, to, domain } = c.req.query() as unknown as TAnalyticsQuery;
  // Slice the single fetch+compute overview to just its time-series periods.
  const data = (await analyticsService.getAnalyticsOverview(ctx, projectId, from, to, domain)).periods;
  return c.json({ data });
}

/**
 * GET /analytics/overview - summary + periods together, from ONE underlying
 * traffic fetch. The dashboard reads this so a project view makes a single
 * cloud round-trip instead of two (separate /summary + /periods).
 *
 * `domain` scopes the numbers to a single tracked domain (multi-domain
 * projects); omitted, it aggregates every domain like before.
 */
export async function overview(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId, from, to, domain } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await analyticsService.getAnalyticsOverview(ctx, projectId, from, to, domain);
  return c.json({ data });
}

// ─── Deployment stats ────────────────────────────────────────────────────────

/** GET /analytics/deployments - deployment success/fail/avg build stats */
export async function deploymentStats(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await analyticsService.getDeploymentStats(ctx, projectId);
  return c.json({ data });
}

// ─── Resource usage ──────────────────────────────────────────────────────────

/** GET /analytics/usage - current container resource usage */
export async function usage(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const data = await analyticsService.getContainerUsage(ctx, projectId);
  return c.json({ data });
}

/** GET /analytics/container - container info (status, IP, uptime) */
export async function containerInfo(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const data = await analyticsService.getContainerInfo(ctx, projectId);
  return c.json({ data });
}

/** GET /analytics/usage/stream - SSE stream of real-time resource usage */
export async function usageStream(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageStreamQuery;

  // Verify project belongs to caller's active org. Membership is already
  // confirmed by the route middleware.
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    return c.json({ error: "Project not found" }, 404);
  }

  if (!project.activeDeploymentId) {
    return c.json({ error: "No active deployment" }, 404);
  }

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep?.containerId) {
    return c.json({ error: "No active container" }, 404);
  }

  const { runtime, serverId } = await resolveDeploymentRuntime(dep);

  return streamSSE(c, async (sseStream) => {
    if (serverId) sshManager.retain(serverId);
    const intervalMs = 5_000;
    const ac = new AbortController();
    sseStream.onAbort(() => ac.abort());

    try {
      while (!ac.signal.aborted) {
        try {
          const stats = await runtime.getUsage(dep.containerId!);
          await sseStream.writeSSE({
            event: "usage",
            data: JSON.stringify({ timestamp: new Date().toISOString(), ...stats }),
          });
        } catch {
          if (ac.signal.aborted) break;
          await sseStream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: "Failed to fetch usage" }),
          });
        }
        // Abort-aware sleep - resolves immediately on disconnect
        await new Promise<void>((resolve) => {
          if (ac.signal.aborted) return resolve();
          const timer = setTimeout(resolve, intervalMs);
          ac.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    } finally {
      if (serverId) sshManager.release(serverId);
    }
  });
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/** GET /analytics/dashboard - overview stats for the active org's dashboard */
export async function dashboard(c: Context) {
  const ctx = getRequestContext(c);
  const data = await analyticsService.getDashboardStats(ctx);
  return c.json({ data });
}

// ─── Server analytics (OpenResty scraped data) ───────────────────────────────

/**
 * GET /analytics/server/:serverId - persisted minute-bucket analytics.
 * Query: ?domain=&from=&to= (ISO timestamps or epoch minutes)
 */
export async function serverAnalytics(c: Context) {
  const serverId = param(c, "serverId");
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param is required" }, 400);

  // Viewing analytics IS what drives a scrape — no background interval. Fire
  // and forget (self-throttled); this read returns current DB rows and the
  // fresh buckets land for the next read/refresh while the page stays open.
  void scrapeServerIfStale(serverId);

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
 * GET /analytics/server/:serverId/geo - daily geo aggregates from DB.
 * Query: ?domain=&day=YYYYMMDD
 */
export async function serverGeo(c: Context) {
  const serverId = param(c, "serverId");
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param is required" }, 400);

  // On-demand scrape (self-throttled, deduped with serverAnalytics).
  void scrapeServerIfStale(serverId);

  const day = c.req.query("day") ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const geo = await repos.analytics.queryGeo({ serverId, domain, day });
  return c.json({ data: geo ?? { countries: {} } });
}

/**
 * GET /analytics/server/:serverId/live - proxy live analytics from the
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
