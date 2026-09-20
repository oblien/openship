import { randomUUID } from "node:crypto";
import { getPlatform } from "@repo/adapters";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { IssueRescan } from "@repo/contracts";
import type { IssueDependencies } from "../../../issues";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { deferBackgroundWork } from "../../lib/background-work";
import { assertNativeJobs, nativeJobsEnabled } from "../../native/execution-policy";
import { assertSelfHosted } from "../system/server-access";
import { runJobNow, systemJobAvailability } from "../jobs/job.service";
import { getCurrentHealthScan, listWorkloadHealthSnapshots, runCurrentHealthScan } from "../monitoring/health-watch";
import { listOrganizationIssues } from "./issues.service";

const RESCAN_JOBS = ["services:health-watch", "infra:scan", "domains:verify-pending", "updates:scan"] as const;
let activeRescan: IssueRescan | null = null;

async function hasFullProjectRead(ctx: ExecutionContext) {
  return authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: "*", action: "read", scope: "all" });
}

export const issuesDependencies: IssueDependencies = {
  collection: {
    async list(ctx, input = {}) { const status = input.status ?? "open"; return { ...await listOrganizationIssues(ctx, { status }), status }; },
    async summary(ctx) { return (await listOrganizationIssues(ctx)).counts; },
    async health(ctx) {
      assertSelfHosted();
      const available = systemJobAvailability("services:health-watch") === "available";
      const [rows, job, servers, all] = await Promise.all([
        Promise.resolve(listWorkloadHealthSnapshots(ctx.organizationId)), repos.job.findByKey("services:health-watch"),
        repos.server.listByOrganization(ctx.organizationId), hasFullProjectRead(ctx),
      ]);
      const serverNames = new Map(servers.map(server => [server.id, server.name ?? server.sshHost]));
      const visible = [];
      for (const row of rows) {
        if (!all && !(await authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: row.projectId, action: "read" }))) continue;
        visible.push({ ...row, serverName: row.serverId ? serverNames.get(row.serverId) ?? row.serverId : "This server" });
      }
      return {
        workloads: visible, watching: available && nativeJobsEnabled() && (job?.enabled ?? false),
        capabilities: { current: getPlatform().target !== "cloud", continuous: available && nativeJobsEnabled() },
        currentScan: all ? getCurrentHealthScan(ctx.organizationId) : null,
        watcher: { key: "services:health-watch", schedule: job?.cronExpression ?? null, available, eventsEnabled: available && nativeJobsEnabled() && !env.OPENSHIP_DISABLE_CONTAINER_EVENTS },
      };
    },
    async scanHealth(ctx) {
      assertSelfHosted();
      // This existing scanner covers the whole organization and returns aggregate counts.
      await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: "*", action: "read", scope: "all" });
      return runCurrentHealthScan(ctx.organizationId);
    },
  },
  jobs: {
    async rescanStatus(ctx) { assertSelfHosted(); await instanceAuthorization.assert(ctx, "read"); return activeRescan; },
    async rescan(ctx) {
      assertSelfHosted();
      await instanceAuthorization.assert(ctx);
      assertNativeJobs();
      if (activeRescan?.status === "running") return activeRescan;
      const available = RESCAN_JOBS.filter(key => systemJobAvailability(key) === "available");
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
          } catch (error) { stage.status = "failed"; stage.error = safeErrorMessage(error); }
        }));
        session.status = "completed";
        session.finishedAt = new Date().toISOString();
      }).catch(error => { console.error("[issues] rescan failed:", safeErrorMessage(error)); });
      audit.recordAsync(operationAuditContext(ctx), { eventType: "job:write", resourceType: "job", after: { operation: "issues.rescan", scanSessionId: session.id, stages: available, skipped: RESCAN_JOBS.filter(key => !available.includes(key)) } });
      return session;
    },
  },
};
