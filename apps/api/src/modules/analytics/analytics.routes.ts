/**
 * Analytics routes - mounted at /api/analytics in app.ts.
 *
 * All routes require authentication. Every route declares a permission
 * tag enforced by secureRouter middleware (check + audit emission).
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxyByQuery } from "../../lib/cloud/project-router";
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

/* ─── Deployment stats ─────────────────────────────────────────────────── */
r.get("/deployments", { tag: "analytics:read", mcp: { description: "Deployment statistics (frequency, success rate, durations)." } }, cloudProjectProxyByQuery, ctrl.deploymentStats);

/* ─── Resource usage ───────────────────────────────────────────────────── */
r.get("/usage", { tag: "analytics:read", mcp: { description: "Resource usage (CPU/memory/bandwidth) for the org or a project." } }, cloudProjectProxyByQuery, ctrl.usage);
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
