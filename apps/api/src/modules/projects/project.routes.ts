/**
 * Project routes — mounted at /api/projects in app.ts.
 *
 * All routes require authentication.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./project.controller";

export const projectRoutes = new Hono();

/* All project routes require authentication */
projectRoutes.use("*", authMiddleware);

/* ─── Projects CRUD ────────────────────────────────────────────────────── */
projectRoutes.get("/", ctrl.list);
projectRoutes.post("/", ctrl.create);
projectRoutes.get("/:id", ctrl.getById);
projectRoutes.patch("/:id", ctrl.update);
projectRoutes.delete("/:id", ctrl.remove);

/* ─── Environment variables ────────────────────────────────────────────── */
projectRoutes.get("/:id/env", ctrl.listEnvVars);
projectRoutes.put("/:id/env", ctrl.setEnvVars);

/* ─── Resources ────────────────────────────────────────────────────────── */
projectRoutes.get("/:id/resources", ctrl.getResources);
projectRoutes.patch("/:id/resources", ctrl.updateResources);
