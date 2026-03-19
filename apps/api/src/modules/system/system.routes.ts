/**
 * System routes — mounted at /api/system in app.ts.
 *
 * Self-hosted only (gated by localOnly in app.ts).
 *
 * Auth strategies:
 *   - /setup routes use internalAuth (Electron → API, no user session)
 *   - all other routes use authMiddleware (auto-injected local user)
 */

import { Hono } from "hono";
import { authMiddleware, internalAuth, localOnly } from "../../middleware";
import * as fs from "./filesystem.controller";
import * as setup from "./setup.controller";
import * as serverCheck from "./server-check.controller";
import * as serversCtrl from "./servers.controller";

export const systemRoutes = new Hono();

systemRoutes.use("*", localOnly);

/* ── Internal routes (Electron → API with shared token) ─────────── */
systemRoutes.post("/setup", internalAuth, setup.setup);
systemRoutes.get("/setup", internalAuth, setup.getSetup);

/* ── Authenticated routes (dashboard settings page) ─────────────── */
systemRoutes.get("/settings", authMiddleware, setup.getSetup);
systemRoutes.patch("/settings", authMiddleware, setup.updateSettings);
systemRoutes.delete("/settings", authMiddleware, setup.deleteSettings);

/* ── Servers CRUD ───────────────────────────────────────────────── */
systemRoutes.get("/servers", authMiddleware, serversCtrl.listServers);
systemRoutes.get("/servers/:id", authMiddleware, serversCtrl.getServer);
systemRoutes.post("/servers", authMiddleware, serversCtrl.createServer);
systemRoutes.patch("/servers/:id", authMiddleware, serversCtrl.updateServer);
systemRoutes.delete("/servers/:id", authMiddleware, serversCtrl.deleteServer);

/* ── Server check & install (dashboard setup wizard) ────────────── */
systemRoutes.post("/test-connection", authMiddleware, serverCheck.testConnection);
systemRoutes.post("/check", authMiddleware, serverCheck.checkServer);
systemRoutes.post("/install", authMiddleware, serverCheck.installComponent);
systemRoutes.post("/install/stream", authMiddleware, serverCheck.installStream);
systemRoutes.get("/install/stream", authMiddleware, serverCheck.attachInstallStream);
systemRoutes.get("/install/session", authMiddleware, serverCheck.getInstallSession);

/* ── Server monitoring (live stats via SSE) ─────────────────────── */
systemRoutes.get("/monitor/stream", authMiddleware, serverCheck.monitorStream);

/* ── Authenticated routes (local user auto-injected) ────────────── */
systemRoutes.use("/browse", authMiddleware);
systemRoutes.get("/browse", fs.browse);
