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
import { AgentExecBody } from "../../lib/agent-exec.schema";
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
r.post(
  // #336: real env for named keys only. With `environment`, reads service-scoped
  // env_var rows; without it, reads compose-inline values for import/config forms.
  // Write-gated on purpose. POST keeps key names out of URLs and proxy logs.
  // No mcp block: revealing secrets stays a dashboard action, off automation.
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
// In-container exec. `project:service:write` means a {project,<id>,[write]} grant
// confines an agent to this project's services — per-resource scope, unlike the
// org-singleton `job` tag the previous exec workaround rode on.
r.post(
  "/:serviceId/exec",
  {
    tag: "project:service:write",
    // Tighter than the default-authed 3000/min: each call opens a pooled SSH
    // connection and runs an arbitrary command, so the generic read budget is the
    // wrong shape for it.
    rateLimit: "write-authed",
    body: AgentExecBody,
    mcp: {
      description:
        "Run a shell command inside this service's running container and return its exit code and combined output. Interpreted by `sh -c`; stderr is merged in. Times out (default 30s, max 120s) and truncates large output. Requires a Docker runtime — a bare or cloud-hosted service has no container to enter.",
    },
  },
  cloudProjectProxy,
  ctrl.execInService,
);
r.patch(
  "/:serviceId",
  {
    tag: "project:service:write",
    body: UpdateServiceBody,
    mcp: {
      description:
        "Update a service's configuration. Partial: an omitted field is left alone. `environment` and `advanced` are MERGED onto the stored values rather than replacing them — omit a key to keep it, set a key to null to remove it, send null for the whole field to clear it. Env values read back masked as `••••••••`; echo the sentinel to keep one unchanged. Every other field (`ports`, `volumes`, `dependsOn`, `publicEndpoints`, …) REPLACES its stored value wholesale, so send the complete list.",
    },
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
/* `restart` is a BOUNCE, not a config apply — a container's environment is fixed
 * when it is created. With pending env changes it answers 409 SERVICE_CONFIG_STALE
 * naming the drifted keys instead of silently re-running the old config (GH-615);
 * `?force=true` bounces anyway. Declaring a `body`/`query` schema here would be
 * wrong twice over: `RouteSpec` has no `query` field, and a `body` schema makes
 * secureRouter mount tbValidator("json"), which 400s the CLI's bodyless POST
 * (its api-client always sets Content-Type: application/json). */
r.post("/:serviceId/restart", { tag: "project:service:write", mcp: { description: "Restart (bounce) this service's container. Does NOT apply changed env/config — it answers 409 SERVICE_CONFIG_STALE when env changed since the running container was created. To APPLY config, trigger a refresh deploy: POST /api/deployments {refresh:true, serviceIds:[serviceId]}. Pass ?force=true to bounce despite pending changes." } }, cloudProjectProxy, ctrl.restartContainer);

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
