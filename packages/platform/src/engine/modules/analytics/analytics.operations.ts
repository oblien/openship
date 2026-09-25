import { setTimeout as delay } from "node:timers/promises";
import { AppError, ValidationError, type DeploymentEvent } from "@repo/contracts";
import { repos } from "@repo/db";
import type { AnalyticsDependencies } from "../../../analytics";
import type { ExecutionContext } from "../../../context";
import { guardedStream } from "../../../guarded-stream";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { trackBackgroundWork } from "../../lib/background-work";
import { assertResourceInOrg } from "../../lib/resource-access";
import { fetchMgmt, resolveProjectTrafficSources } from "../../lib/project-analytics";
import { getAdminOblienClient } from "../../lib/oblien-user-client";
import { sshManager } from "../../lib/ssh-manager";
import { scrapeServerIfStale } from "../system/analytics-scraper";
import { pushProjectAnalyticsConfig } from "./analytics-config.service";
import { resolveProjectPushTarget } from "../route-rules/route-rule.service";
import { collectProjectUsage, openProjectUsageSampler } from "../monitoring/project-usage";
import { getProjectUsageHistory } from "../monitoring/usage-history";
import * as service from "./analytics.service";
import { getProjectGeo } from "./geo.service";

async function analyticsRead(ctx: ExecutionContext) {
  await authorization.authorize(ctx, { resourceType: "analytics", resourceId: "*", action: "read" });
}
async function trafficRead(ctx: ExecutionContext, id: string) {
  await analyticsRead(ctx);
  if (ctx.scopeMode === "fixed" && !getAdminOblienClient() && (await resolveProjectTrafficSources(id)).some(source => source.kind === "cloud"))
    throw new AppError("This cloud link has no tenant mapping. Connect the SDK directly to the cloud instance with its organizationId.", 409, "CLOUD_SCOPE_UNAVAILABLE");
}
function minute(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : /^-?\d+$/.test(value) ? Number(value) : Math.floor(new Date(value).getTime() / 60_000);
  if (!Number.isSafeInteger(parsed)) throw new ValidationError("Expected an ISO timestamp or epoch minute");
  return parsed;
}
const DAY_MS = 86_400_000;
function checkedRange(input: { from?: string; to?: string }, days = 1) {
  const to = input.to === undefined ? Date.now() : Date.parse(input.to);
  const from = input.from === undefined ? to - days * DAY_MS : Date.parse(input.from);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ValidationError("Expected valid dates for the analytics range");
  if (to < from) throw new ValidationError("Range end must not precede its start");
  if (to - from > 366 * DAY_MS) throw new ValidationError("Analytics ranges cannot exceed 366 days");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
function refresh(serverId: string) { void trackBackgroundWork(scrapeServerIfStale(serverId)).catch(() => {}); }

export const analyticsDependencies: AnalyticsDependencies = {
  projects: {
    async summary(ctx, id, input = {}) { await trafficRead(ctx, id); return (await service.getAnalyticsOverview(ctx, id, undefined, undefined, input.domain)).summary; },
    async periods(ctx, id, input = {}) { await trafficRead(ctx, id); const range = checkedRange(input); return (await service.getAnalyticsOverview(ctx, id, range.from, range.to, input.domain)).periods; },
    async overview(ctx, id, input = {}) { await trafficRead(ctx, id); const range = checkedRange(input); return service.getAnalyticsOverview(ctx, id, range.from, range.to, input.domain); },
    async geo(ctx, id, input = {}) {
      await trafficRead(ctx, id);
      const range = checkedRange(input, 7);
      // Daily rollups choose seven UTC dates, rather than eight dates touched
      // by a rolling 168-hour range. Preserve an explicitly requested start.
      return getProjectGeo(ctx, id, input.from === undefined ? undefined : range.from, range.to, input.domain);
    },
    async deploymentStats(ctx, id) { await analyticsRead(ctx); return service.getDeploymentStats(ctx, id); },
    async usage(ctx, id) { await analyticsRead(ctx); const usage = await collectProjectUsage(ctx, id); return usage.supported ? usage.overall : null; },
    async resources(ctx, id) { await analyticsRead(ctx); return collectProjectUsage(ctx, id); },
    async containerInfo(ctx, id) { await analyticsRead(ctx); return service.getContainerInfo(ctx, id); },
    async usageHistory(ctx, id, input = {}) { await analyticsRead(ctx); return getProjectUsageHistory(ctx, id, { ...input, ...checkedRange(input) }); },
    async setPathsCollection(ctx, id, input) {
      const project = await repos.project.findById(id);
      assertResourceInOrg(project, "Project", ctx.organizationId, id);
      const { enabled } = input;
      await repos.project.update(id, { collectPaths: enabled });
      const target = await resolveProjectPushTarget(id);
      if (target) await pushProjectAnalyticsConfig(id, target.serverId).catch(() => {});
      audit.recordAsync(operationAuditContext(ctx), { eventType: "project:write", resourceType: "project", resourceId: id, after: { operation: "setPathsCollection", enabled } });
      return { enabled };
    },
  },
  collection: { dashboard: service.getDashboardStats },
  servers: {
    async serverBuckets(_ctx, serverId, input) {
      const now = Math.floor(Date.now() / 60_000);
      const fromMinute = minute(input.from, now - 60), toMinute = minute(input.to, now);
      if (toMinute < fromMinute) throw new ValidationError("Range end must not precede its start");
      if (toMinute - fromMinute > 366 * 1440) throw new ValidationError("Analytics ranges cannot exceed 366 days");
      refresh(serverId);
      return repos.analytics.queryBuckets({ serverId, domain: input.domain, fromMinute, toMinute });
    },
    async serverGeo(_ctx, serverId, input) {
      refresh(serverId);
      const day = input.day ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replace(/-/g, "") !== day) throw new ValidationError("Expected a valid YYYYMMDD date");
      return await repos.analytics.queryGeo({ serverId, domain: input.domain, day }) ?? { countries: {} };
    },
    async serverLive(_ctx, serverId, input) {
      const data = await fetchMgmt(serverId, `/analytics/totals?domain=${encodeURIComponent(input.domain)}`);
      if (!data) throw new AppError("Failed to reach server management API", 502, "ANALYTICS_UPSTREAM_UNAVAILABLE");
      return data;
    },
  },
  async openUsageStream(ctx, id, signal) {
    const sampler = await openProjectUsageSampler(ctx, id);
    if ("error" in sampler) throw new AppError(sampler.error, 404, "NOT_FOUND");
    const sample = sampler.sample;
    const cancellation = new AbortController();
    const closedSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    let retained = false;
    try {
      if (sampler.serverId) { sshManager.retain(sampler.serverId); retained = true; }
    } catch (error) { await sampler.close(); throw error; }
    async function* samples(): AsyncGenerator<DeploymentEvent> {
      while (!closedSignal.aborted) {
        try {
          const value = await sample();
          if (closedSignal.aborted) break;
          yield { event: "usage", data: JSON.stringify(value) };
        } catch {
          if (closedSignal.aborted) break;
          yield { event: "error", data: JSON.stringify({ error: "Failed to fetch usage" }) };
        }
        try { await delay(5_000, undefined, { signal: closedSignal, ref: false }); }
        catch (error) { if (!closedSignal.aborted) throw error; }
      }
    }
    return guardedStream(samples(), { cancel: () => cancellation.abort(), close: async () => {
      try { await sampler.close(); }
      finally { if (retained) sshManager.release(sampler.serverId!); }
    } });
  },
};
