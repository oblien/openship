/**
 * Analytics routes - mounted at /api/analytics in app.ts.
 *
 * All routes require authentication. Every route declares a permission
 * tag enforced by secureRouter middleware (check + audit emission).
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy, cloudProjectProxyByQuery } from "../../lib/cloud/project-router";
import * as ctrl from "./analytics.controller";

const r = secureRouter(new Hono(), {
  module: "analytics",
  basePath: "/api/analytics",
});

/* All analytics routes require authentication. Project-scoped analytics carry
   the project id in the QUERY (?projectId=), so cloudProjectProxyByQuery (after
   the permission middleware) forwards them to the SaaS for a cloud project and
   no-ops for org-wide requests. */

/* ─── Request analytics ────────────────────────────────────────────────── */
r.get("/", { tag: "analytics:read", mcp: { description: "Analytics summary for the org (or ?projectId=): requests, traffic overview." } }, cloudProjectProxyByQuery, ctrl.summary);
r.get("/periods", { tag: "analytics:read", mcp: { description: "Available analytics time periods." } }, cloudProjectProxyByQuery, ctrl.periods);
r.get("/overview", { tag: "analytics:read", mcp: { description: "Analytics overview (traffic, status codes, top paths)." } }, cloudProjectProxyByQuery, ctrl.overview);
r.get("/geo", { tag: "analytics:read", mcp: { description: "Visitor geography for a project: requests per country, distinct visitors, top paths." } }, cloudProjectProxyByQuery, ctrl.projectGeo);
/* Per-path aggregation is the one opt-in analytics dimension — it costs ~57% of the
   edge's per-request counter work. project:write, not analytics:read: this changes what
   the edge does to every request, which is not a read.

   The project id rides the PATH (`:projectId`), unlike the reads' `?projectId=`: a
   per-project WRITE needs the standard project:write resolver to gate THIS project, and
   that resolver reads a URL param. As a query param it fell through to the else-branch's
   `:id` lookup and 400'd "Missing route param :id". `cloudProjectProxy` keys off the same
   `:projectId`, so cloud projects still proxy to the SaaS. */
r.post("/paths-collection/:projectId", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "Turn per-path request aggregation (Top Paths) on or off for a project." } }, cloudProjectProxy, ctrl.setPathsCollection);

/* ─── Deployment stats ─────────────────────────────────────────────────── */
r.get("/deployments", { tag: "analytics:read", mcp: { description: "Deployment statistics (frequency, success rate, durations)." } }, cloudProjectProxyByQuery, ctrl.deploymentStats);

/* ─── Resource usage ───────────────────────────────────────────────────── */
r.get("/usage", { tag: "analytics:read", mcp: { description: "Resource usage (CPU/memory/bandwidth) for the org or a project." } }, cloudProjectProxyByQuery, ctrl.usage);
r.get("/resources", { tag: "analytics:read", mcp: { description: "Project resource usage: overall totals plus a per-service breakdown with live status." } }, cloudProjectProxyByQuery, ctrl.resources);
r.get("/usage/history", { tag: "analytics:read", mcp: { description: "Resource usage over time for a project (CPU/memory/network), optionally scoped to one service." } }, cloudProjectProxyByQuery, ctrl.usageHistory);
r.get("/usage/stream", { tag: "analytics:read" }, cloudProjectProxyByQuery, ctrl.usageStream);
r.get("/container", { tag: "analytics:read", mcp: { description: "Container-level metrics for a project's runtime." } }, cloudProjectProxyByQuery, ctrl.containerInfo);

/* ─── Dashboard ────────────────────────────────────────────────────────── */
r.get("/dashboard", { tag: "analytics:read", mcp: { description: "Dashboard analytics rollup (headline metrics)." } }, cloudProjectProxyByQuery, ctrl.dashboard);

/* ─── Server analytics (scraped from OpenResty mgmt API) ───────────────── */
r.get(
  "/server/:serverId",
  { tag: "server:read", ids: { server: "serverId" } },
  ctrl.serverAnalytics,
);
r.get(
  "/server/:serverId/geo",
  { tag: "server:read", ids: { server: "serverId" } },
  ctrl.serverGeo,
);
r.get(
  "/server/:serverId/live",
  { tag: "server:read", ids: { server: "serverId" } },
  ctrl.serverAnalyticsLive,
);

export const analyticsRoutes = r.hono;
