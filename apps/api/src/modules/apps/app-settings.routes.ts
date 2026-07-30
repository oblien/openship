/**
 * App settings routes — mounted at /api/projects/:id/app-settings in app.ts.
 *
 * Scoped to the project (`:id`) so it reuses the standard project permission
 * check + `cloudProjectProxy` (a cloud app's env is canonical on the SaaS, so
 * the proxy forwards there; self-hosted runs locally).
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./app.controller";
import { AppSettingsPatchBody } from "./app.schema";

const r = secureRouter(new Hono(), {
  module: "apps",
  basePath: "/api/projects/:id/app-settings",
});

r.get(
  "/",
  { tag: "project:read", mcp: { description: "Get an installed app's curated settings schema + current values." } },
  cloudProjectProxy,
  ctrl.getSettings,
);
r.patch(
  "/",
  { tag: "project:write", body: AppSettingsPatchBody, mcp: { description: "Update an installed app's curated settings (safe env merge)." } },
  cloudProjectProxy,
  ctrl.patchSettings,
);

export const appSettingsRoutes = r.hono;
