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
    collection: true,
    localOnly: true,
    mcp: {
      description:
        "Run the checkers behind GET /issues immediately (health watch, managed-container scan, pending domain verification, update scan) instead of waiting for their schedules, then re-read GET /issues. Returns which jobs ran, which were skipped as not applicable to this platform, and which failed. Adds no new probing — these are the same scheduled jobs, recorded in the jobs history as manual runs. Self-hosted only.",
    },
  },
  ctrl.rescanIssues,
);

export const issuesRoutes = r.hono;
