/**
 * Analytics controller - handlers for analytics + usage + stats endpoints.
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { sshManager } from "../../lib/ssh-manager";
import { repos } from "@repo/db";
import * as analyticsService from "./analytics.service";
import * as geoService from "./geo.service";
import { collectProjectUsage, openProjectUsageSampler } from "../monitoring/project-usage";
import { getProjectUsageHistory } from "../monitoring/usage-history";
import { fetchMgmt } from "../../lib/project-analytics";
import { scrapeServerIfStale } from "../system/analytics-scraper";
import { permission } from "../../lib/permission";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { pushProjectAnalyticsConfig } from "./analytics-config.service";
import { resolveProjectPushTarget } from "../route-rules/route-rule.service";
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

/**
 * GET /analytics/geo - visitor geography + daily rollup for a project.
 *
 * Mode-agnostic to the caller: self-hosted reads the scraped archive plus a live
 * edge tail, cloud reads through to Oblien. Both return the same shape, so the
 * country map has one contract.
 */
export async function projectGeo(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId, from, to, domain } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await geoService.getProjectGeo(ctx, projectId, from, to, domain);
  return c.json({ data });
}

/**
 * POST /analytics/paths-collection - turn per-path aggregation on or off.
 *
 * Persists first, then pushes to the edge. That order matters: the shared dict is RAM and
 * is re-pushed from the row on every route apply, so a push that fails is corrected by the
 * next apply — whereas a push that succeeded against an unsaved row would be silently
 * reverted by that same apply.
 */
export async function setPathsCollection(c: Context) {
  const ctx = getRequestContext(c);
  // Path param, not ?projectId= — the project:write route resolver already asserted
  // write on this id from the URL, so the assert below is defense-in-depth, not the gate.
  const id = c.req.param("projectId") ?? "";
  await permission.assert(ctx, { resourceType: "project", resourceId: id, action: "write" });

  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);

  const body = await c.req.json().catch(() => ({}));
  const enabled = body?.enabled === true;

  await repos.project.update(id, { collectPaths: enabled });
  const target = await resolveProjectPushTarget(id);
  if (target) {
    await pushProjectAnalyticsConfig(id, target.serverId).catch(() => {});
  }
  return c.json({ data: { enabled } });
}

/** GET /analytics/deployments - deployment success/fail/avg build stats */
export async function deploymentStats(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TAnalyticsQuery;
  const data = await analyticsService.getDeploymentStats(ctx, projectId);
  return c.json({ data });
}

// ─── Resource usage ──────────────────────────────────────────────────────────

/**
 * GET /analytics/usage - current resource usage, flat ResourceUsage shape.
 *
 * Backed by the same collector as /analytics/resources and returning its `overall`,
 * so on a compose project this is now the WHOLE stack rather than whichever service
 * happened to own `deployment.containerId`. Kept as its own route because existing
 * callers expect the flat shape, not the per-service envelope.
 */
export async function usage(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const collected = await collectProjectUsage(ctx, projectId);
  // Null rather than zeros when unmeasurable — the previous contract for "no active
  // deployment" was also null, and zeros would read as a genuinely idle app.
  return c.json({ data: collected.supported ? collected.overall : null });
}

/** GET /analytics/container - container info (status, IP, uptime) */
export async function containerInfo(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const data = await analyticsService.getContainerInfo(ctx, projectId);
  return c.json({ data });
}

/**
 * GET /analytics/resources - one-shot project resource usage (overall + per-service).
 */
export async function resources(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageQuery;
  const data = await collectProjectUsage(ctx, projectId);
  return c.json({ data });
}

/**
 * GET /analytics/usage/history - resource usage over time.
 *
 * `serviceKey` omitted = All (the per-bucket sum across services). The live stream
 * next door answers "right now"; this answers "was memory climbing before the OOM".
 */
export async function usageHistory(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId, from, to, serviceKey } = c.req.query() as unknown as TUsageQuery & {
    serviceKey?: string;
  };
  const data = await getProjectUsageHistory(ctx, projectId, { from, to, serviceKey });
  return c.json({ data });
}

/**
 * GET /analytics/usage/stream - SSE stream of real-time resource usage.
 *
 * Emits the WHOLE project each tick — overall totals plus one entry per service —
 * so the card and the per-service dots share a single connection and can never
 * disagree about which tick they're showing. It used to stream one container
 * (`deployment.containerId`), which on a compose project is just the primary
 * service.
 *
 * The runtime is resolved ONCE for the life of the stream (see
 * openProjectUsageSampler) instead of per tick, and via the read-only resolver so
 * a polled read never contends on the provision lock.
 */
export async function usageStream(c: Context) {
  const ctx = getRequestContext(c);
  const { projectId } = c.req.query() as unknown as TUsageStreamQuery;

  const sampler = await openProjectUsageSampler(ctx, projectId);
  if ("error" in sampler) return c.json({ error: sampler.error }, 404);

  const { serverId, sample, close } = sampler;

  return streamSSE(c, async (sseStream) => {
    if (serverId) sshManager.retain(serverId);
    const intervalMs = 5_000;
    const ac = new AbortController();
    sseStream.onAbort(() => ac.abort());

    try {
      while (!ac.signal.aborted) {
        try {
          await sseStream.writeSSE({ event: "usage", data: JSON.stringify(await sample()) });
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
      await close();
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
