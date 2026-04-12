/**
 * Project routes — mounted at /api/projects in app.ts.
 *
 * All routes require authentication.
 */

import { Hono } from "hono";
import { authMiddleware, localOnly } from "../../middleware";
import * as ctrl from "./project.controller";

export const projectRoutes = new Hono();

/* All project routes require authentication */
projectRoutes.use("*", authMiddleware);

/* ─── Local-only routes (hidden in cloud mode) ─────────────────────────── */
projectRoutes.get("/local", localOnly, ctrl.listLocal);
projectRoutes.post("/scan", localOnly, ctrl.scanLocal);
projectRoutes.post("/import", localOnly, ctrl.importLocal);

/* ─── Top-level project operations ─────────────────────────────────────── */
projectRoutes.get("/home", ctrl.getHome);
projectRoutes.post("/ensure", ctrl.ensure);
projectRoutes.get("/", ctrl.list);
projectRoutes.post("/", ctrl.create);

/* ─── Projects CRUD ────────────────────────────────────────────────────── */
projectRoutes.get("/:id", ctrl.getById);
projectRoutes.patch("/:id", ctrl.update);
projectRoutes.delete("/:id", ctrl.remove);
projectRoutes.get("/:id/info", ctrl.getInfo);
projectRoutes.post("/:id/update", ctrl.updatePost);
projectRoutes.post("/:id/delete", ctrl.deletePost);

/* ─── Build options ────────────────────────────────────────────────────── */
projectRoutes.post("/:id/options", ctrl.setOptions);

/* ─── Enable / Disable ─────────────────────────────────────────────────── */
projectRoutes.post("/:id/enable", ctrl.enable);
projectRoutes.post("/:id/disable", ctrl.disable);

/* ─── Environment variables ────────────────────────────────────────────── */
projectRoutes.get("/:id/env", ctrl.listEnvVars);
projectRoutes.put("/:id/env", ctrl.setEnvVars);
projectRoutes.get("/:id/env/get", ctrl.envGet);
projectRoutes.post("/:id/env/set", ctrl.envSet);

/* ─── Git ──────────────────────────────────────────────────────────────── */
projectRoutes.get("/:id/git", ctrl.getGitInfo);
projectRoutes.post("/:id/branch", ctrl.setBranch);

/* ─── Resources ────────────────────────────────────────────────────────── */
projectRoutes.get("/:id/resources", ctrl.getResources);
projectRoutes.patch("/:id/resources", ctrl.updateResources);
projectRoutes.post("/:id/resources", ctrl.updateResources);

/* ─── Sleep mode ───────────────────────────────────────────────────────── */
projectRoutes.post("/:id/sleep-mode", ctrl.setSleepMode);

/* ─── Deployments ──────────────────────────────────────────────────────── */
projectRoutes.get("/:id/deployments", ctrl.listDeployments);
projectRoutes.post("/:id/deployment-session", ctrl.deploymentSession);
/* ─── Custom domain ─────────────────────────────────────────────────────────── */
projectRoutes.post("/:id/connect", ctrl.connectDomain);
/* ─── Runtime logs ─────────────────────────────────────────────────────── */
projectRoutes.get("/:id/logs", ctrl.runtimeLogs);
projectRoutes.get("/:id/logs/stream", ctrl.runtimeLogStream);

/* ─── Server HTTP request logs (OpenResty live pipe) ───────────────────── */
projectRoutes.get("/:id/server-logs/recent", ctrl.recentServerLogs);
projectRoutes.get("/:id/server-logs/stream", ctrl.serverLogStream);
