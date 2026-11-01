/**
 * Service routes — mounted as sub-routes of /api/projects/:id/services.
 *
 * Every route declares a permission TAG that the secureRouter middleware
 * enforces (permission check + audit event). The boot scanner refuses
 * to start if any route lacks one.
 *
 * Cloud-as-source: `:id` is the project id. After permission checks, the shared
 * gateway forwards the whole request to the SaaS for a cloud
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
import {
  ServiceResourceSchemas,
  RuntimeLogsInputSchema,
  AgentExecBody,
  CreateServiceBody,
  SetServiceEnvVarsBody,
  MergeServiceEnvVarsBody,
  SyncServicesBody,
  UpdateServiceBody,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./service.controller";

const r = secureRouter(new Hono(), {
  module: "services",
  basePath: "/api/projects/:id/services",
});

/* Auth runs before any permission check. */

/* ─── Service CRUD ─────────────────────────────────────────────────────── */
r.get(
  "/",
  { tag: "project:service:list", mcp: { description: "List a project's services (compose services / monorepo sub-apps)." } },
  ctrl.list,
);
r.post(
  "/",
  {
    // Create: no :serviceId yet, so scope the check to the collection (the
    // parent project :id is in the basePath and enforced by the shared gateway /
    // the handler). Without collection:true the middleware demands :serviceId
    // and 400s "Missing route param" before the handler runs.
    tag: "project:service:write", auditHandledByOperation: true,
    collection: true,
    body: CreateServiceBody,
     mcp: { description: "Add a service to a project.",
   },
  },
  ctrl.create,
);
r.get(
  "/containers",
  { tag: "project:read", mcp: { description: "List the running containers for a project's services." } },
  ctrl.activeContainers,
);
r.post(
  "/sync",
  {
    tag: "project:service:write", auditHandledByOperation: true,
    collection: true,
    body: SyncServicesBody,
    mcp: {
      description: "Sync services from the project's docker-compose file into the service table.",
    },
  },
  ctrl.syncFromCompose,
);
r.get(
  "/:serviceId",
  { tag: "project:service:read", mcp: { description: "Get one service by id." } },
  ctrl.getById,
);
r.post(
  // #336: real env for named keys only. With `environment`, reads service-scoped
  // env_var rows; without it, reads compose-inline values for import/config forms.
  // Write-gated on purpose. POST keeps key names out of URLs and proxy logs.
  // No mcp block: revealing secrets stays a dashboard action, off automation.
  "/:serviceId/env-reveal",
  { tag: "project:service:write", auditHandledByOperation: true, mcpExcluded: "Explicit dashboard secret reveal. MCP reads masked effective environment and saves named overrides without retrieving plaintext." },
  ctrl.revealEnv,
);
r.get(
  "/:serviceId/volume-sizes",
  {
    tag: "project:service:read",
     mcp: { description: "Measure the on-disk size (du) of each of a service's volumes.",
   },
  },
  ctrl.volumeSizes,
);
r.get(
  "/:serviceId/logs",
  { tag: "project:service:read", mcp: { description: "Fetch a service's runtime logs (non-streaming)." }, query: RuntimeLogsInputSchema },
  ctrl.runtimeLogs,
);
r.get(
  "/:serviceId/logs/stream",
  { tag: "project:service:read", mcpExcluded: "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming." },
  ctrl.runtimeLogStream,
);
// In-container exec. `project:service:write` means a {project,<id>,[write]} grant
// confines an agent to this project's services — per-resource scope, unlike the
// org-singleton `job` tag the previous exec workaround rode on.
r.post(
  "/:serviceId/exec",
  {
    tag: "project:service:write", auditHandledByOperation: true,
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
  ctrl.execInService,
);
r.patch(
  "/:serviceId",
  {
    tag: "project:service:write", auditHandledByOperation: true,
    body: UpdateServiceBody,
    mcp: {
      description:
        "Update a service's configuration. Partial: an omitted field is left alone. `environment` and `advanced` are MERGED onto the stored values rather than replacing them — omit a key to keep it, set a key to null to remove it, send null for the whole field to clear it. Env values read back masked as `••••••••`; echo the sentinel to keep one unchanged. Every other field (`ports`, `volumes`, `dependsOn`, `publicEndpoints`, …) REPLACES its stored value wholesale, so send the complete list.",
    },
  },
  ctrl.update,
);
r.delete(
  "/:serviceId",
  { tag: "project:service:admin", auditHandledByOperation: true, mcp: { description: "Delete this service from its project and clean up its owned runtime. Review persistent volumes and dependent services before removing it." } },
  ctrl.remove,
);

/* ─── Compose drift (accept upstream / keep edits) ──────────────────────── */
r.post(
  "/:serviceId/drift/accept",
  { tag: "project:service:write", auditHandledByOperation: true, mcp: { description: "Accept upstream docker-compose changes for this service." } },
  ctrl.acceptDrift,
);
r.post(
  "/:serviceId/drift/keep",
  { tag: "project:service:write", auditHandledByOperation: true, mcp: { description: "Keep local edits over upstream docker-compose changes for this service." } },
  ctrl.keepDrift,
);

/* ─── Per-service container actions ─────────────────────────────────────── */
r.post("/:serviceId/start", { tag: "project:service:write", auditHandledByOperation: true, mcp: { description: "Start this service's container." } }, ctrl.startContainer);
r.post("/:serviceId/stop", { tag: "project:service:write", auditHandledByOperation: true, mcp: { description: "Stop this service's container." } }, ctrl.stopContainer);
/* `restart` is a BOUNCE, not a config apply — a container's environment is fixed
 * when it is created. With pending env changes it answers 409 SERVICE_CONFIG_STALE
 * naming the drifted keys instead of silently re-running the old config (GH-615);
 * `?force=true` bounces anyway. The query schema advertises the shared operation input without adding a JSON
 * body validator, so the CLI's bodyless POST remains valid. */
r.post("/:serviceId/restart", { tag: "project:service:write", auditHandledByOperation: true, mcp: { description: "Restart (bounce) this service's container. Answers 409 SERVICE_CONFIG_STALE when saved env is pending. Use POST /api/projects/:id/services/:serviceId/apply-env to apply it, or ?force=true to bounce with the old env." }, query: ServiceResourceSchemas.restart.input }, ctrl.restartContainer);
r.post("/:serviceId/apply-env", {
  tag: "project:service:write", auditHandledByOperation: true, rateLimit: "write-authed",
   mcp: { description: "Apply saved runtime environment to this service using its current image and runtime configuration. Gracefully replaces its container without a build or deployment session. Returns after the replacement starts; preserves the previous configuration on failure.",
 },
}, ctrl.applyEnvironment);

/* ─── Service environment variables ─────────────────────────────────────── */
r.get(
  "/:serviceId/environment",
  {
    tag: "project:service:read",
    mcp: {
      description:
        "Read the effective saved environment for a service, including Compose and shared project values. Optionally compare it with its deployed container. Secrets are masked.",
    },
    query: ServiceResourceSchemas.getEnvironment.input,
  },
  ctrl.getEnvironment,
);
r.patch(
  "/:serviceId/env",
  {
    tag: "project:service:write",
    auditHandledByOperation: true,
    body: MergeServiceEnvVarsBody,
    mcp: {
      description:
        "Save named service environment changes. By default edits are service overrides. To update inherited project values, review with env/review and supply its shared keys and revision. Project write access is required. Saving does not restart containers or edit repository files.",
    },
  },
  ctrl.mergeEnvVars,
);
r.post(
  "/:serviceId/env/review",
  {
    tag: "project:service:write",
    // A read-only review accepts secret edits; never audit the request body.
    auditHandledByOperation: true,
    body: ServiceResourceSchemas.reviewEnvVars.input,
    mcp: {
      description: "Review shared project values affected by service environment edits. Returns variable names, affected services and a revision for confirmation; no values are exposed or saved.",
    },
  },
  ctrl.reviewEnvVars,
);
r.get(
  "/:serviceId/env",
  { tag: "project:service:read", mcp: { description: "List a service's environment variables." }, query: ServiceResourceSchemas.listEnvVars.input },
  ctrl.listEnvVars,
);
r.put(
  "/:serviceId/env",
  {
    tag: "project:service:write", auditHandledByOperation: true,
    body: SetServiceEnvVarsBody,
     mcp: { description: "Replace a service's environment variables.",
   },
  },
  ctrl.setEnvVars,
);

export const serviceRoutes = r.hono;
