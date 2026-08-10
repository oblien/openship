/**
 * Service routes — mounted as sub-routes of /api/projects/:id/services.
 *
 * Every route declares a permission TAG that the secureRouter middleware
 * enforces (permission check + audit event). The boot scanner refuses
 * to start if any route lacks one.
 *
 * Cloud-as-source: the `:id` is the project id, so `cloudProjectProxy` (after
 * the permission middleware) forwards the whole request to the SaaS for a cloud
 * project, or falls through to the local handler for a local project.
 *
 * Tag conventions used here:
 *   project:service:list  — list services for a project
 *   project:service:read  — read one service
 *   project:service:write — create/update service or container actions
 *   project:service:admin — delete service
 *   project:read          — listing containers for a project (project-scoped)
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./service.controller";
import {
  CreateServiceBody,
  SetServiceEnvVarsBody,
  SyncServicesBody,
  UpdateServiceBody,
} from "./service.schema";

const r = secureRouter(new Hono(), {
  module: "services",
  basePath: "/api/projects/:id/services",
});

/* Auth runs before any permission check. */

/* ─── Service CRUD ─────────────────────────────────────────────────────── */
r.get(
  "/",
  { tag: "project:service:list", mcp: { description: "List a project's services (compose services / monorepo sub-apps)." } },
  cloudProjectProxy,
  ctrl.list,
);
r.post(
  "/",
  {
    // Create: no :serviceId yet, so scope the check to the collection (the
    // parent project :id is in the basePath + enforced by cloudProjectProxy /
    // the handler). Without collection:true the middleware demands :serviceId
    // and 400s "Missing route param" before the handler runs.
    tag: "project:service:write",
    collection: true,
    body: CreateServiceBody,
    mcp: { description: "Add a service to a project." },
  },
  cloudProjectProxy,
  ctrl.create,
);
r.get(
  "/containers",
  { tag: "project:read", mcp: { description: "List the running containers for a project's services." } },
  cloudProjectProxy,
  ctrl.activeContainers,
);
r.post(
  "/sync",
  {
    tag: "project:service:write",
    collection: true,
    body: SyncServicesBody,
    mcp: {
      description: "Sync services from the project's docker-compose file into the service table.",
    },
  },
  cloudProjectProxy,
  ctrl.syncFromCompose,
);
r.get(
  "/:serviceId",
  { tag: "project:service:read", mcp: { description: "Get one service by id." } },
  cloudProjectProxy,
  ctrl.getById,
);
r.get(
  // #336: real (unmasked) compose env. Write-gated on purpose — read-only
  // callers only ever see the masked map from GET /:serviceId. No mcp block:
  // revealing secrets stays a dashboard action, off the automation surface.
  "/:serviceId/env-reveal",
  { tag: "project:service:write" },
  cloudProjectProxy,
  ctrl.revealEnv,
);
r.get(
  "/:serviceId/volume-sizes",
  {
    tag: "project:service:read",
    mcp: { description: "Measure the on-disk size (du) of each of a service's volumes." },
  },
  cloudProjectProxy,
  ctrl.volumeSizes,
);
r.get(
  "/:serviceId/logs",
  { tag: "project:service:read", mcp: { description: "Fetch a service's runtime logs (non-streaming)." } },
  cloudProjectProxy,
  ctrl.runtimeLogs,
);
r.get(
  "/:serviceId/logs/stream",
  { tag: "project:service:read" },
  cloudProjectProxy,
  ctrl.runtimeLogStream,
);
r.patch(
  "/:serviceId",
  {
    tag: "project:service:write",
    body: UpdateServiceBody,
    mcp: { description: "Update a service's configuration." },
  },
  cloudProjectProxy,
  ctrl.update,
);
r.delete(
  "/:serviceId",
  { tag: "project:service:admin" },
  cloudProjectProxy,
  ctrl.remove,
);

/* ─── Compose drift (accept upstream / keep edits) ──────────────────────── */
r.post(
  "/:serviceId/drift/accept",
  { tag: "project:service:write", mcp: { description: "Accept upstream docker-compose changes for this service." } },
  cloudProjectProxy,
  ctrl.acceptDrift,
);
r.post(
  "/:serviceId/drift/keep",
  { tag: "project:service:write", mcp: { description: "Keep local edits over upstream docker-compose changes for this service." } },
  cloudProjectProxy,
  ctrl.keepDrift,
);

/* ─── Per-service container actions ─────────────────────────────────────── */
r.post("/:serviceId/start", { tag: "project:service:write", mcp: { description: "Start this service's container." } }, cloudProjectProxy, ctrl.startContainer);
r.post("/:serviceId/stop", { tag: "project:service:write", mcp: { description: "Stop this service's container." } }, cloudProjectProxy, ctrl.stopContainer);
r.post("/:serviceId/restart", { tag: "project:service:write", mcp: { description: "Restart this service's container." } }, cloudProjectProxy, ctrl.restartContainer);

/* ─── Service environment variables ─────────────────────────────────────── */
r.get(
  "/:serviceId/env",
  { tag: "project:service:read", mcp: { description: "List a service's environment variables." } },
  cloudProjectProxy,
  ctrl.listEnvVars,
);
r.put(
  "/:serviceId/env",
  {
    tag: "project:service:write",
    body: SetServiceEnvVarsBody,
    mcp: { description: "Replace a service's environment variables." },
  },
  cloudProjectProxy,
  ctrl.setEnvVars,
);

export const serviceRoutes = r.hono;
