/**
 * Deployment routes — mounted at /api/deployments in app.ts.
 *
 * All routes require authentication.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./deployment.controller";

export const deploymentRoutes = new Hono();

/* All deployment routes require authentication */
deploymentRoutes.use("*", authMiddleware);

/* ─── Deployments ──────────────────────────────────────────────────────── */
deploymentRoutes.get("/", ctrl.list);
deploymentRoutes.post("/", ctrl.create);
deploymentRoutes.get("/:id", ctrl.getById);
deploymentRoutes.get("/:id/logs", ctrl.logs);
deploymentRoutes.get("/:id/stream", ctrl.stream);
deploymentRoutes.post("/:id/rollback", ctrl.rollback);
deploymentRoutes.post("/:id/cancel", ctrl.cancel);
deploymentRoutes.post("/:id/restart", ctrl.restart);
deploymentRoutes.get("/:id/info", ctrl.containerInfo);
deploymentRoutes.get("/:id/usage", ctrl.containerUsage);
deploymentRoutes.get("/:id/build-logs", ctrl.buildLogs);
