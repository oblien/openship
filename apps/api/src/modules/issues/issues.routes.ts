/**
 * Issues routes — mounted at /api/issues.
 *
 * The reads are `project:list`: an org-wide list, same tag as `/projects/home`.
 * Infrastructure rows inside the response carry their OWN gate (`server:read`,
 * checked in the service), so a member without server access gets a valid feed of
 * the projects they can see rather than a 403 for the whole page.
 *
 * Not `localOnly`: on the SaaS the deploy/domain/update sources still work and the
 * self-hosted ones resolve empty, so the page is useful in both modes without the
 * dashboard branching on deploy mode.
 */
import { Hono } from "hono";
import { IssueCollectionSchemas, IssueJobSchemas } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./issues.controller";

const r = secureRouter(new Hono(), {
  module: "issues",
  basePath: "/api/issues",
});

r.get(
  "/",
  {
    tag: "project:list",
    mcp: {
      description:
        "THE place to answer \"what is broken right now?\" across the whole installation — start here before per-project tools. One org-wide feed that merges every check Openship already runs: container health incidents (unhealthy / crash_loop / down, plus a server-level `server_unreachable` row when a whole box is offline), managed edge/mail container state, deploy blockers and held prompts, partial-release decisions, unsynced routing, port advisories, unverified domains, certificate errors, and available updates. Each item carries `severity` (`outage` = not being served right now, `action_required`, `advisory`), a `target` with a dashboard href, and `resolveWith` — concrete {method, path} calls that fix it, callable as-is. Items whose fix is a managed container carry `infraFix` instead (a UI flow, not an API call). `?status=resolved` returns incident HISTORY (the only source with a lifecycle; up to 30 days), so a resolved-tab absence never means \"nothing else ever broke\". Infrastructure rows require server read access and are absent in cloud mode.",
    },
    query: IssueCollectionSchemas.list.input,
  },
  ctrl.listIssues,
);

r.get(
  "/summary",
  {
    tag: "project:list",
    mcp: {
      description:
        "Counts only from the same feed as GET /issues: {outage, actionRequired, advisory, total}. Use for a quick health verdict; read GET /issues for the rows and their fixes.",
    },
  },
  ctrl.issuesSummary,
);

r.get(
  "/health",
  {
    tag: "project:list",
    mcp: {
      description:
        "Latest health-watch snapshot for every expected workload in the organization. Cached only: this read performs no Docker polling. Includes healthy, unhealthy, crash-looping, down and unknown states plus watcher enabled status.",
    },
  },
  ctrl.healthSnapshot,
);

r.post(
  "/health/scan",
  {
    tag: "project:list",
    readOnly: true,
    collection: true,
    mcp: {
      description:
        "Check the current container state of every deployed workload in the caller's organization, including managed Cloud servers. Reuses the health watch scanner and refreshes only its in-memory snapshots: it does not enable a job, update incident history, send alerts, or start Docker event subscriptions.",
    },
  },
  ctrl.scanCurrentHealth,
);

/**
 * Firing the scheduled checkers early. Tagged `job:write` — NOT `server:write` —
 * because that is literally what this does: it calls the jobs module's run-now, and
 * borrowing a different resource's authority for it would let someone with server
 * access run jobs they can't otherwise run.
 */
r.post(
  "/rescan",
  {
    tag: "job:write",
    body: IssueJobSchemas.rescan.input,
    bodyValidatedByOperation: true,
    auditHandledByOperation: true,
    collection: true,
    localOnly: true,
    mcp: {
      description:
        "Run the checkers behind GET /issues immediately instead of waiting for their schedules, then re-read GET /issues. Send {healthOnly:true} to recheck container/server health without running component updates or domain reconciliation. Returns a scan session with stages; GET /issues/rescan/status follows its completion. These are the existing scheduled jobs, recorded in job history as manual runs. Self-hosted only and requires an instance administrator.",
    },
  },
  ctrl.rescanIssues,
);

r.get(
  "/rescan/status",
  { tag: "job:read", localOnly: true, mcp: { description: "Read the current or most recent issue-rescan session, including stage status, errors and completion. Start once with the rescan tool, then poll this tool instead of launching repeated scans." } },
  ctrl.rescanStatus,
);

export const issuesRoutes = r.hono;
