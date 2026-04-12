/**
 * Analytics routes — mounted at /api/analytics in app.ts.
 *
 * All routes require authentication.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./analytics.controller";

export const analyticsRoutes = new Hono();

/* All analytics routes require authentication */
analyticsRoutes.use("*", authMiddleware);

/* ─── Request analytics ────────────────────────────────────────────────── */
analyticsRoutes.get("/", ctrl.summary);
analyticsRoutes.get("/periods", ctrl.periods);

/* ─── Deployment stats ─────────────────────────────────────────────────── */
analyticsRoutes.get("/deployments", ctrl.deploymentStats);

/* ─── Resource usage ───────────────────────────────────────────────────── */
analyticsRoutes.get("/usage", ctrl.usage);
analyticsRoutes.get("/usage/stream", ctrl.usageStream);
analyticsRoutes.get("/container", ctrl.containerInfo);

/* ─── Dashboard ────────────────────────────────────────────────────────── */
analyticsRoutes.get("/dashboard", ctrl.dashboard);

/* ─── Server analytics (scraped from OpenResty mgmt API) ───────────────── */
analyticsRoutes.get("/server/:serverId", ctrl.serverAnalytics);
analyticsRoutes.get("/server/:serverId/geo", ctrl.serverGeo);
analyticsRoutes.get("/server/:serverId/live", ctrl.serverAnalyticsLive);
