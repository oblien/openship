/**
 * Settings routes — mounted at /api/settings in app.ts.
 *
 * All routes require authentication. Manages user platform preferences
 * (build mode, etc.) that sync across devices and to Openship Cloud.
 *
 * System-level settings (SSH creds, server connection) are stored locally
 * in Electron's ConfigStore — they never touch this API.
 */
import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth";
import * as ctrl from "./settings.controller";

export const settingsRoutes = new Hono();

settingsRoutes.use("*", authMiddleware);

/** GET  /            — get current user's workspace settings */
settingsRoutes.get("/", ctrl.get);

/** PUT  /            — create or update workspace settings */
settingsRoutes.put("/", ctrl.upsert);

/** PATCH /build-mode — update only build mode preference */
settingsRoutes.patch("/build-mode", ctrl.updateBuildMode);
