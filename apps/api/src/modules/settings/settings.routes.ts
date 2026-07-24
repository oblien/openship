/**
 * Settings routes - mounted at /api/settings in app.ts.
 *
 * All routes require authentication. Manages user platform preferences
 * (build mode, etc.) that sync across devices and to Openship Cloud.
 *
 * System-level settings (SSH creds, server connection) are stored locally
 * in Electron's ConfigStore - they never touch this API.
 */
import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./settings.controller";

const r = secureRouter(new Hono(), {
  module: "settings",
  basePath: "/api/settings",
});


// `settings` is an org-singleton resource (declared in
// ORG_SINGLETON_RESOURCES). The middleware automatically passes
// resourceId="*" and resolves the org context from the X-Organization-Id
// header or session default — no per-route id mapping needed.

/** GET  /            - get current org's workspace settings */
r.get("/", { tag: "settings:read", mcp: { description: "Get the org's workspace settings (build mode, deploy defaults, preferences)." } }, ctrl.get);

/** PUT  /            - create or update workspace settings */
r.put("/", { tag: "settings:write" }, ctrl.upsert);

/** PATCH /build-mode - update only build mode preference */
r.patch("/build-mode", { tag: "settings:write", mcp: { description: "Set the default build mode (server / local)." } }, ctrl.updateBuildMode);

/** PATCH /route-strategy - update only the edge→app route strategy default */
r.patch("/route-strategy", { tag: "settings:write", mcp: { description: "Set the default edge→app route strategy (auto / loopback-port / container-ip)." } }, ctrl.updateRouteStrategy);

/** PATCH /deploy-defaults - set/clear the default deploy target + server */
r.patch("/deploy-defaults", { tag: "settings:write", mcp: { description: "Set/clear the default deploy target (local/server/cloud) and server." } }, ctrl.updateDeployDefaults);

/** PATCH /clone-credentials - set/clear the user-global git clone token */
r.patch("/clone-credentials", { tag: "settings:write" }, ctrl.updateCloneCredentials);

/** PATCH /clone-strategy-preference - save the first-time deploy nudge choice */
r.patch("/clone-strategy-preference", { tag: "settings:write", mcp: { description: "Set the default clone strategy (api-host / server)." } }, ctrl.updateCloneStrategyPreference);
r.patch("/transfer", { tag: "settings:write", mcp: { description: "Set the default volume-transfer mode (auto/stream/direct/rsync) and compression (auto/zstd/gzip/none) for migrations." } }, ctrl.updateTransferPrefs);

export const settingsRoutes = r.hono;

