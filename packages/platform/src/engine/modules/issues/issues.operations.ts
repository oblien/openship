import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { randomUUID } from "node:crypto";
import { getPlatform } from "@repo/adapters";
import { repos } from "@repo/db";
import { AppError, safeErrorMessage } from "@repo/core";
import type { IssueRescan } from "@repo/contracts";
import type { IssueDependencies } from "../../../issues";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { deferBackgroundWork } from "../../lib/background-work";
import { assertNativeJobs } from "../../native/execution-policy";
import { assertSelfHosted } from "../system/server-access";
import { runJobNow, systemJobAvailability } from "../jobs/job.service";
import { getCurrentHealthScan, listWorkloadHealthSnapshots, runCurrentHealthScan } from "../monitoring/health-watch";
import { continuousHealthAvailable, containerHealthEventsAvailable, HEALTH_WATCH_JOB, healthWatchActive } from "../monitoring/health-watch-policy";
import { listOrganizationIssues } from "./issues.service";
import { env } from "../../config/env";

const RESCAN_JOBS = [HEALTH_WATCH_JOB, "infra:scan", "domains:verify-pending", "updates:scan"] as const;
let activeRescan: IssueRescan | null = null;

async function hasFullProjectRead(ctx: ExecutionContext) {
  return authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: "*", action: "read", scope: "all" });
}

async function canClearHistory(ctx: ExecutionContext) {
  return !env.CLOUD_MODE && !ctx.tokenScope && ["owner", "admin"].includes(ctx.role) &&
    await authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, {
      resourceType: "project",
      resourceId: "*",
      action: "admin",
      scope: "all",
    });
}

export const issuesDependencies: IssueDependencies = {
  collection: {
    async list(ctx, input = {}) { const status = input.status ?? "open"; return { ...await listOrganizationIssues(ctx, { status }), status, canClearHistory: await canClearHistory(ctx) }; },
    async clearHistory(ctx) {
      assertSelfHosted();
      if (!await canClearHistory(ctx)) throw new AppError(
        "An organization administrator is required to clear monitoring history",
        403,
        "MONITORING_HISTORY_ADMIN_REQUIRED",
      );
      const deleted = await repos.serviceIncident.clearResolvedByOrg(ctx.organizationId, new Date());
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "issues.history.clear",
        after: { operation: "issues.clearHistory", deleted },
      });
      return { deleted };
    },
    async summary(ctx) { return (await listOrganizationIssues(ctx)).counts; },
    async health(ctx) {
      const available = continuousHealthAvailable();
      const [rows, job, servers, all, instanceAdmin, jobWrite] = await Promise.all([
        Promise.resolve(listWorkloadHealthSnapshots(ctx.organizationId)), repos.job.findByKey(HEALTH_WATCH_JOB),
        repos.server.listByOrganization(ctx.organizationId), hasFullProjectRead(ctx),
        instanceAuthorization.allows(ctx),
        authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "job", resourceId: "*", action: "write" }),
      ]);
      const serverNames = new Map(servers.map(server => [server.id, server.name ?? server.sshHost]));
      const visible = [];
      for (const row of rows) {
        if (!all && !(await authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: row.projectId, action: "read" }))) continue;
        visible.push({ ...row, serverName: row.serverId ? serverNames.get(row.serverId) ?? row.serverId : "This server" });
      }
      return {
        workloads: visible, watching: healthWatchActive(job),
        capabilities: { current: all, continuous: available },
        currentScan: all ? getCurrentHealthScan(ctx.organizationId) : null,
        watcher: {
          key: HEALTH_WATCH_JOB, schedule: job?.cronExpression ?? null, available,
          eventsEnabled: healthWatchActive(job) && containerHealthEventsAvailable(),
          canManage: available && instanceAdmin && jobWrite,
          runsWhileAppOpen: getPlatform().target === "desktop",
        },
      };
    },
    async scanHealth(ctx) {
      // This existing scanner covers the whole organization and returns aggregate counts.
      await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: "*", action: "read", scope: "all" });
      return runCurrentHealthScan(ctx.organizationId);
    },
  },
  jobs: {
    async rescanStatus(ctx) { assertSelfHosted(); await instanceAuthorization.assert(ctx, "read"); return activeRescan; },
    async rescan(ctx, input = {}) {
      assertSelfHosted();
      await instanceAuthorization.assert(ctx);
      assertNativeJobs();
      if (activeRescan?.status === "running") return activeRescan;
      // Recovery of an observation gap must not also run infra's opted-in
      // auto-updates or domain reconciliation. Reuse the health job alone.
      const available = RESCAN_JOBS.filter(key =>
        (!input.healthOnly || key === HEALTH_WATCH_JOB) && systemJobAvailability(key) === "available",
      );
      const session: IssueRescan = activeRescan = {
        id: randomUUID(), status: "running", startedAt: new Date().toISOString(),
        stages: RESCAN_JOBS.map(key => ({ key, status: available.includes(key) ? "pending" : "skipped" })),
      };
      void deferBackgroundWork(async () => {
        await Promise.all(available.map(async key => {
          const stage = session.stages.find(item => item.key === key)!;
          stage.status = "running";
          try {
            const result = await runJobNow(key);
            stage.status = "completed";
            stage.summary = result.summary ?? {};
          } catch (error) {
            observeCaughtError(error, "platform/engine/modules/issues/issues.operations"); stage.status = "failed"; stage.error = safeErrorMessage(error); }
        }));
        session.status = "completed";
        session.finishedAt = new Date().toISOString();
      }).catch(error => { errorDiagnostics.error("platform/engine/modules/issues/issues.operations", "[issues] rescan failed:", safeErrorMessage(error), error); });
      audit.recordAsync(operationAuditContext(ctx), { eventType: "job:write", resourceType: "job", after: { operation: "issues.rescan", scanSessionId: session.id, stages: available, skipped: RESCAN_JOBS.filter(key => !available.includes(key)) } });
      return session;
    },
  },
};
