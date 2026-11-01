/** Customer-owned host routes. Shared operations resolve ownership and enforce
 * Manage in SaaS; operator-local filesystem/setup routes are never mounted here. */
import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import {
  RemoveServerInputSchema,
  ServerInstallSessionInputSchema,
  ApplyAllServerContainersInputSchema,
  ResourceIdSchema,
  ServerComponentInputSchema,
  InstallServerComponentsInputSchema,
  ServerInstallResponseInputSchema,
  CreateServerInputSchema,
  UpdateServerRateLimitSchema,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as serversCtrl from "./servers.controller";
import * as serverCheck from "./server-check.controller";
import * as rateLimit from "./rate-limit.controller";
import * as serverContainers from "./server-containers.controller";
import * as serverModules from "./server-modules.controller";
const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system" });
// `id` is retained for released desktop clients and SDK/server compatibility.
const installSessionQuery = Type.Object({
  ...ServerInstallSessionInputSchema.properties,
  id: Type.Optional(ResourceIdSchema),
}, { additionalProperties: false });
r.get(
  "/servers/:id/infrastructure",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read this server’s attached private networks and compute cluster, subject to fleet visibility. Use these resource IDs to inspect network or k3s readiness.",
    },
  },
  serversCtrl.getInfrastructure,
);
// Read-only blast-radius snapshot for the removal confirm: which projects and apps
// this box currently runs, and which server-scoped records go with it.
r.get(
  "/servers/:id/deletion-preview",
  {
    tag: "server:read",
    mcp: {
      description:
        "Preview which projects, apps and server-scoped records would be affected by deleting this server. Review this before removal; no resources are changed.",
    },
  },
  serversCtrl.serverDeletionPreview,
);
// Create has no :id in the URL — org scope comes from the request and the
// row is created in the active org. collection:true keeps the permission
// middleware from demanding a (nonexistent) :id param.
r.post(
  "/servers",
  {
    tag: "server:write",
    collection: true,
    body: CreateServerInputSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Register a deployment server with SSH connection settings. Credentials are encrypted by the existing server operation. This does not create a cloud machine; test its connection and inspect prerequisites next.",
    },
  },
  serversCtrl.createServer,
);

r.delete(
  "/servers/:id",
  {
    tag: "server:admin",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Remove this registered server and its managed records. Read deletion-preview first. query.destroyOnSource explicitly selects remote workload destruction; without it, workloads are left on the source.",
    },
    query: RemoveServerInputSchema,
  },
  serversCtrl.deleteServer,
);
// Host exec. `server:admin` on the id, so a {server,<id>,[admin]} grant confines an
// agent to this one box — the per-resource scope the jobs-based workaround could not
// express. MCP-exposed deliberately: this is the sanctioned agent execution point.

/* ── Per-server rate limiting (OpenResty level) ─────────────────── */
r.get(
  "/servers/:id/rate-limit",
  {
    tag: "server:read",
    mcp: {
      description:
        "Read this server’s OpenResty request-rate limit, burst allowance and whitelist.",
    },
  },
  rateLimit.getRateLimit,
);
r.patch(
  "/servers/:id/rate-limit",
  {
    tag: "server:admin",
    body: UpdateServerRateLimitSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Update the server-wide OpenResty rate limit and whitelist. This affects traffic to all routes on the server.",
    },
  },
  rateLimit.updateRateLimit,
);

// ── Native-module versioning + migration (OpenResty, …). The `:id` server is
//    the permission resource; shared operations check host type and org scope. ──
r.get(
  "/servers/:id/modules",
  {
    tag: "server:read",
    mcp: {
      description:
        "List installed native modules, available updates and migrations requiring consent on this server.",
    },
  },
  serverModules.listServerModules,
);
r.post(
  "/servers/:id/modules/scan",
  {
    tag: "server:write",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Refresh native-module versions and available migration information on this server. Does not apply updates.",
    },
  },
  serverModules.scanServerModules,
);
r.post(
  "/servers/:id/modules/:module/apply",
  {
    tag: "server:write",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Apply available updates to this native server module through its owned migration workflow. Read modules first and inspect pendingConsent in the result; a returned consent request is not a completed update.",
    },
  },
  serverModules.applyServerModuleUpdate,
);

r.post(
  "/test-connection",
  {
    tag: "server:write",
    collection: true,
    body: CreateServerInputSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Test draft SSH connection settings before registering a server. Does not save a server or install components.",
    },
  },
  serverCheck.testConnection,
);

r.post(
  "/install",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    body: Type.Object(
      { ...ServerComponentInputSchema.properties, serverId: ResourceIdSchema },
      { additionalProperties: false },
    ),
    auditHandledByOperation: true,
    mcp: {
      description:
        "Install one named component on body.serverId using the shared server installer. Read check first. For k3s cluster setup use the compute-cluster runtime tool, which verifies the whole cluster.",
    },
  },
  serverCheck.installComponent,
);
r.post(
  "/remove",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    body: Type.Object(
      { ...ServerComponentInputSchema.properties, serverId: ResourceIdSchema },
      { additionalProperties: false },
    ),
    auditHandledByOperation: true,
    mcp: {
      description:
        "Remove one managed component from body.serverId. This may interrupt workloads using it; read component readiness and removal restrictions first.",
    },
  },
  serverCheck.removeComponent,
);
r.post(
  "/install/stream",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    body: Type.Object(
      { ...InstallServerComponentsInputSchema.properties, serverId: ResourceIdSchema },
      { additionalProperties: false },
    ),
    auditHandledByOperation: true,
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  serverCheck.installStream,
);
r.post(
  "/install/respond",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    body: ServerInstallResponseInputSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Answer a server installation’s current pending prompt using its sessionId and an offered action ID. Read install/session first; never invent a takeover decision.",
    },
  },
  serverCheck.installRespond,
);
r.get(
  "/install/stream",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    query: installSessionQuery,
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  serverCheck.attachInstallStream,
);
r.get(
  "/install/session",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read the current or named server installation session, including progress and pending decisions. query.serverId selects the server; query.sessionId reattaches to a specific session.",
    },
    query: installSessionQuery,
  },
  serverCheck.getInstallSession,
);

// ── Managed CONTAINER versioning (edge / mail images pinned to APP_VERSION).
//    Same `:id`-server permission resource + cloud/org guards as modules; apply
//    STREAMS the rollback-guarded image swap. ──
// Org-wide drift count for the home nudge — no :id, so collection:true scopes
// the permission check to the active org (like /install/stream, /monitor/stream)
// instead of demanding a server param.
r.get(
  "/containers/behind",
  {
    tag: "server:read",
    collection: true,
    mcp: {
      description:
        "Read the fleet-wide count of managed containers with available updates. This reads cached inventory; scan to refresh it.",
    },
  },
  serverContainers.containersBehind,
);
r.get(
  "/containers/issues",
  {
    tag: "server:read",
    collection: true,
    mcp: {
      description:
        "List managed-container problems across the server fleet, including stale or unreachable observations.",
    },
  },
  serverContainers.containerIssues,
);
// Global infra view — every server × component. No :id, so collection:true scopes
// the check to the active org (same as /containers/behind). Scan is detect-only.
r.get(
  "/containers",
  {
    tag: "server:read",
    collection: true,
    mcp: {
      description:
        "List the cached managed-container inventory across registered servers. Scan the fleet or one server for fresh observations.",
    },
  },
  serverContainers.listAllContainers,
);
// Live progress for the fleet view: what's queued/running right now (cached rows ×
// in-memory sessions) plus what just settled, which is the only place an outcome
// lives — a finished row clears its drift and its in-progress flag together.
r.get(
  "/containers/applying",
  {
    tag: "server:read",
    collection: true,
    mcp: {
      description:
        "Read queued, running and recently completed managed-container update or repair operations. Poll after starting a fleet apply.",
    },
  },
  serverContainers.listApplyingContainers,
);
r.post(
  "/containers/scan",
  {
    tag: "server:write",
    collection: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Refresh managed-container versions and health across the server fleet without applying updates.",
    },
  },
  serverContainers.scanAllContainers,
);
// Fleet bulk apply — targets are derived from the cache server-side, so the body
// only carries which intents to run ("update" swaps, "repair" restarts).
r.post(
  "/containers/apply-all",
  {
    tag: "server:write",
    collection: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Start the selected update or repair intents for managed containers across the fleet. Targets come from current inventory. Poll containers/applying for progress and failures.",
    },
    body: ApplyAllServerContainersInputSchema,
    bodyValidatedByOperation: true,
  },
  serverContainers.applyAllContainers,
);
r.get(
  "/servers/:id/containers",
  {
    tag: "server:read",
    mcp: {
      description:
        "Read managed containers and their cached health/version information on this server.",
    },
  },
  serverContainers.listServerContainers,
);
r.post(
  "/servers/:id/containers/scan",
  {
    tag: "server:write",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Refresh managed-container versions and health on this server without applying changes.",
    },
  },
  serverContainers.scanServerContainers,
);
r.post(
  "/servers/:id/containers/:component/apply/stream",
  {
    tag: "server:write",
    auditHandledByOperation: true,
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  serverContainers.applyServerContainerStream,
);
// Read-only siblings of the POST apply stream, for page reloads: /session hands
// back a running swap's id, /stream (GET) re-attaches to it. Neither can start a
// run, so they stay on server:read while the POST keeps server:write.
r.get(
  "/servers/:id/containers/:component/apply/session",
  {
    tag: "server:read",
    mcp: {
      description:
        "Read the active managed-container update or repair session for this server component. This only observes an existing operation.",
    },
  },
  serverContainers.getServerContainerApplySession,
);
r.get(
  "/servers/:id/containers/:component/apply/stream",
  {
    tag: "server:read",
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  serverContainers.attachServerContainerStream,
);

export const connectedServerRoutes = r.hono;
