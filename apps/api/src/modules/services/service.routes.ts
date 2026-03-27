/**
 * Service routes — mounted as sub-routes of /api/projects/:id/services
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./service.controller";

export const serviceRoutes = new Hono();

/* All service routes require authentication */
serviceRoutes.use("*", authMiddleware);

/* ─── Service CRUD ─────────────────────────────────────────────────────── */
serviceRoutes.get("/", ctrl.list);
serviceRoutes.get("/containers", ctrl.activeContainers);
serviceRoutes.post("/sync", ctrl.syncFromCompose);
serviceRoutes.get("/:serviceId", ctrl.getById);
serviceRoutes.patch("/:serviceId", ctrl.update);

/* ─── Per-service container actions ─────────────────────────────────────── */
serviceRoutes.post("/:serviceId/start", ctrl.startContainer);
serviceRoutes.post("/:serviceId/stop", ctrl.stopContainer);
serviceRoutes.post("/:serviceId/restart", ctrl.restartContainer);

/* ─── Service environment variables ─────────────────────────────────────── */
serviceRoutes.get("/:serviceId/env", ctrl.listEnvVars);
serviceRoutes.put("/:serviceId/env", ctrl.setEnvVars);
