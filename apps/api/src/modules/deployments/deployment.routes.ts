/**
 * Deployment routes — mounted at /api/deployments in app.ts.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./deployment.controller";

export const deploymentRoutes = new Hono();
deploymentRoutes.use("*", authMiddleware);

/* ── CRUD + operations ─────────────────────────────────────────────── */
deploymentRoutes.get("/", ctrl.list);
deploymentRoutes.post("/", ctrl.create);
deploymentRoutes.post("/prepare", ctrl.prepare);

/* ── Build access (creates a new deployment — no ID yet) ───────────── */
deploymentRoutes.post("/build/access", ctrl.buildAccess);

/* ── SSL ───────────────────────────────────────────────────────────── */
deploymentRoutes.post("/ssl/status", ctrl.sslStatus);
deploymentRoutes.post("/ssl/renew", ctrl.sslRenew);

/* ── Deployment by ID ──────────────────────────────────────────────── */
deploymentRoutes.get("/:id", ctrl.getById);
deploymentRoutes.get("/:id/logs", ctrl.logs);
deploymentRoutes.get("/:id/stream", ctrl.stream);
deploymentRoutes.get("/:id/build", ctrl.buildStatus);
deploymentRoutes.post("/:id/build", ctrl.buildStart);
deploymentRoutes.post("/:id/redeploy", ctrl.buildRedeploy);
deploymentRoutes.post("/:id/rollback", ctrl.rollback);
deploymentRoutes.post("/:id/cancel", ctrl.cancel);
deploymentRoutes.delete("/:id", ctrl.remove);
deploymentRoutes.post("/:id/restart", ctrl.restart);
deploymentRoutes.post("/:id/build/respond", ctrl.buildRespond);
deploymentRoutes.get("/:id/info", ctrl.containerInfo);
deploymentRoutes.get("/:id/usage", ctrl.containerUsage);

