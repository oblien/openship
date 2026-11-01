/**
 * Analytics routes - mounted at /api/analytics in app.ts.
 *
 * All routes require authentication. Every route declares a permission
 * tag enforced by secureRouter middleware (check + audit emission).
 */

import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import {
  ResourceIdSchema,
  AnalyticsDomainSchema,
  AnalyticsRangeSchema,
  AnalyticsServerSchemas,
  AnalyticsProjectSchemas,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxyByQuery } from "../../lib/cloud/project-router";
import * as ctrl from "./analytics.controller";

const r = secureRouter(new Hono(), {
  module: "analytics",
  basePath: "/api/analytics",
});

const projectQuery = Type.Object({ projectId: ResourceIdSchema }, { additionalProperties: false });
const projectDomainQuery = Type.Object({ projectId: ResourceIdSchema, ...AnalyticsDomainSchema.properties }, { additionalProperties: false });
const projectRangeQuery = Type.Object({ projectId: ResourceIdSchema, ...AnalyticsRangeSchema.properties }, { additionalProperties: false });

/* All analytics routes require authentication. Project-scoped analytics carry
   the project id in the QUERY (?projectId=), so cloudProjectProxyByQuery (after
   the permission middleware) forwards them to the SaaS for a cloud project and
   no-ops for org-wide requests. */

/* ─── Request analytics ────────────────────────────────────────────────── */
r.get("/", { tag: "analytics:read", mcp: { description: "Read request and traffic totals for query.projectId, optionally filtered by domain. Requires a project ID; use dashboard for the workspace rollup." }, query: projectDomainQuery }, cloudProjectProxyByQuery, ctrl.summary);
r.get("/periods", { tag: "analytics:read", mcp: { description: "Available analytics time periods." }, query: projectRangeQuery }, cloudProjectProxyByQuery, ctrl.periods);
r.get("/overview", { tag: "analytics:read", mcp: { description: "Analytics overview (traffic, status codes, top paths)." }, query: projectRangeQuery }, cloudProjectProxyByQuery, ctrl.overview);
r.get("/geo", { tag: "analytics:read", mcp: { description: "Visitor geography for a project: requests per country, distinct visitors, top paths." }, query: projectRangeQuery }, cloudProjectProxyByQuery, ctrl.projectGeo);
/* Per-path aggregation is the one opt-in analytics dimension — it costs ~57% of the
   edge's per-request counter work. project:write, not analytics:read: this changes what
   the edge does to every request, which is not a read.

   The project id rides the PATH (`:projectId`), unlike the reads' `?projectId=`: a
   per-project WRITE needs the standard project:write resolver to gate THIS project, and
   that resolver reads a URL param. As a query param it fell through to the else-branch's
   `:id` lookup and 400'd "Missing route param :id". The shared Cloud gateway keys off the same
   `:projectId`, so cloud projects still proxy to the SaaS. */
r.post("/paths-collection/:projectId", { tag: "project:write", body: AnalyticsProjectSchemas.setPathsCollection.input, auditHandledByOperation: true, ids: { project: "projectId" }, mcp: { description: "Turn per-path request aggregation (Top Paths) on or off for a project." } }, ctrl.setPathsCollection);

/* ─── Deployment stats ─────────────────────────────────────────────────── */
r.get("/deployments", { tag: "analytics:read", mcp: { description: "Deployment statistics (frequency, success rate, durations)." }, query: projectQuery }, cloudProjectProxyByQuery, ctrl.deploymentStats);

/* ─── Resource usage ───────────────────────────────────────────────────── */
r.get("/usage", { tag: "analytics:read", mcp: { description: "Read current runtime resource usage for query.projectId. Unsupported runtimes return no observation; this does not imply zero usage." }, query: projectQuery }, cloudProjectProxyByQuery, ctrl.usage);
r.get("/resources", { tag: "analytics:read", mcp: { description: "Project resource usage: overall totals plus a per-service breakdown with live status." }, query: projectQuery }, cloudProjectProxyByQuery, ctrl.resources);
r.get("/usage/history", { tag: "analytics:read", mcp: { description: "Resource usage over time for a project (CPU/memory/network), optionally scoped to one service." }, query: Type.Object({ projectId: ResourceIdSchema, ...AnalyticsProjectSchemas.usageHistory.input.properties }, { additionalProperties: false }) }, cloudProjectProxyByQuery, ctrl.usageHistory);
r.get("/usage/stream", { tag: "analytics:read", mcpExcluded: "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming." }, cloudProjectProxyByQuery, ctrl.usageStream);
r.get("/container", { tag: "analytics:read", mcp: { description: "Container-level metrics for a project's runtime." }, query: projectQuery }, cloudProjectProxyByQuery, ctrl.containerInfo);

/* ─── Dashboard ────────────────────────────────────────────────────────── */
r.get("/dashboard", { tag: "analytics:read", mcp: { description: "Dashboard analytics rollup (headline metrics)." } }, cloudProjectProxyByQuery, ctrl.dashboard);

/* ─── Server analytics (scraped from OpenResty mgmt API) ───────────────── */
r.get(
  "/server/:serverId",
  { tag: "server:read", ids: { server: "serverId" }, mcp: { description: "Read saved edge request/traffic buckets for query.domain on this server, optionally within an ISO date range. These are HTTP traffic measurements, not k3s workload CPU metrics." }, query: AnalyticsServerSchemas.serverBuckets.input },
  ctrl.serverAnalytics,
);
r.get(
  "/server/:serverId/geo",
  { tag: "server:read", ids: { server: "serverId" }, mcp: { description: "Read this server’s saved visitor geography for query.domain and optional query.day (YYYYMMDD). Missing observations are not zero traffic." }, query: AnalyticsServerSchemas.serverGeo.input },
  ctrl.serverGeo,
);
r.get(
  "/server/:serverId/live",
  { tag: "server:read", ids: { server: "serverId" }, mcp: { description: "Read current OpenResty counters for query.domain on this server. This is a point-in-time JSON observation, not a continuous stream." }, query: AnalyticsServerSchemas.serverLive.input },
  ctrl.serverAnalyticsLive,
);

export const analyticsRoutes = r.hono;
