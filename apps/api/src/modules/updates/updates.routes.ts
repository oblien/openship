/**
 * Updates routes — mounted at /api/updates.
 *
 * Org-singleton `updates` resource (see route-permission.ts) — any org member
 * can read the update list and trigger a rescan.
 */
import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./updates.controller";

const r = secureRouter(new Hono(), {
  module: "updates",
  basePath: "/api/updates",
});

r.get(
  "/",
  { tag: "updates:read", mcp: { description: "List update statuses for the org (apps, projects, self-app, webmail). ?behind=1 filters to those with an update available." } },
  ctrl.listUpdates,
);
r.post(
  "/scan",
  { tag: "updates:write", auditHandledByOperation: true, mcp: { description: "Trigger a fresh update scan across the org's projects/apps." } },
  ctrl.triggerScan,
);
r.post(
  "/:projectId/apply",
  { tag: "project:write", auditHandledByOperation: true, ids: { project: "projectId" }, mcp: { description: "Apply the available update to a project/app (force-pulls image tags, redeploys, pre-deploy backup)." } },
  ctrl.applyUpdate,
);

export const updatesRoutes = r.hono;
