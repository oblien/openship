/** Server resource API shared by connected hosts and managed Cloud instances. */
import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import {
  ServerCollectionSchemas,
  ServerResourceSchemas,
  UpdateServerInputSchema,
  AgentExecBody,
  CheckServerInputSchema,
  ResourceIdSchema,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as serversCtrl from "./servers.controller";
import * as serverCheck from "./server-check.controller";

const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system" });

r.get(
  "/servers/destinations",
  {
    tag: "server:list",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read accessible deployment servers and their capabilities. Use serverId to place a project on a connected or managed Cloud server.",
    },
  },
  serversCtrl.serverDestinations,
);

r.get(
  "/servers",
  {
    tag: "server:list",
    mcp: {
      description:
        "List registered deployment servers accessible to this credential, with server IDs and connection summaries. Use these IDs for infrastructure operations; private-network and compute-cluster IDs are different.",
    },
  },
  serversCtrl.listServers,
);

r.get(
  "/servers/:id",
  {
    tag: "server:read",
    mcp: {
      description:
        "Read this registered server’s configuration, supported capabilities, managed plan and lifecycle progress. Stored SSH secrets are not returned. Use reachability for a fresh connection check.",
    },
  },
  serversCtrl.getServer,
);

r.get(
  "/servers/:id/reachability",
  {
    tag: "server:read",
    mcp: {
      description:
        "Probe whether the Openship controller can reach this server now. A controller connection failure is not evidence that deployed applications are down.",
    },
  },
  serversCtrl.probeReachability,
);

r.patch(
  "/servers/:id",
  {
    tag: "server:write",
    body: UpdateServerInputSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Update this registered server’s name or SSH connection settings. Omitted fields are preserved. Check reachability after changing connection settings.",
    },
  },
  serversCtrl.updateServer,
);

r.post(
  "/servers/:id/exec",
  {
    tag: "server:admin",
    // Tighter than the default-authed 3000/min: each call opens a pooled SSH
    // connection and runs an arbitrary command, so the generic read budget is the
    // wrong shape for it.
    rateLimit: "write-authed",
    body: AgentExecBody,
    mcp: {
      description:
        "Run a shell command on this server's host and return its exit code and combined output. Interpreted by `sh -c`, so pipes and redirects work; stderr is merged in. Times out (default 30s, max 120s) and truncates large output. Use this to inspect or repair a server; prefer the read-only endpoints when they answer the question.",
    },
  },
  serversCtrl.execOnServer,
);

r.post(
  "/check",
  {
    tag: "server:admin",
    body: Type.Object(
      { ...CheckServerInputSchema.properties, serverId: ResourceIdSchema },
      { additionalProperties: false },
    ),
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Inspect required software and component readiness on body.serverId. Returns missing components and health messages; does not install them.",
    },
  },
  serverCheck.checkServer,
);

r.get(
  "/monitor/stream",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  serverCheck.monitorStream,
);

r.post(
  "/servers/:id/ports/scan",
  {
    tag: "server:read",
    readOnly: true,
    mcp: {
      description:
        "Inspect listening ports through this server's execution connection. Returns protocol, bound address and process without changing listeners. Managed Cloud listeners are inside the server; public access is controlled by provider networking and project routes.",
    },
  },
  serverCheck.scanExposedPorts,
);

r.post(
  "/servers/managed",
  {
    tag: "server:admin",
    collection: true,
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerCollectionSchemas.createManaged.input,
    mcp: {
      description:
        "Create a managed Cloud server identity. Projects share its purchased capacity and use the Docker or bare runtime. This does not charge or provision. Subscribe to this server in Billing, then ensure it. Use the returned serverId for management and deployment.",
    },
  },
  serversCtrl.createManagedServer,
);
r.get("/servers/managed/available", {
  tag: "server:admin", collection: true, authorizationHandledByOperation: true,
  mcp: { description: "List managed servers available through this installation's connected Cloud account. Does not create a server or copy projects. Use connectManaged to add a selected server to this organization." },
}, serversCtrl.availableManagedServers);
r.post("/servers/managed/connect", {
  tag: "server:admin", collection: true, authorizationHandledByOperation: true, auditHandledByOperation: true,
  body: ServerCollectionSchemas.connectManaged.input,
  mcp: { description: "Connect an existing managed Cloud server to this self-hosted organization. Verifies Cloud server administration and pins its account identity. Returns the local serverId to use for deployments; no projects or subscriptions are copied." },
}, serversCtrl.connectManagedServer);
r.get(
  "/servers/:id/usage",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read measured CPU, memory and disk usage plus accessible projects on this server. Purchased disk is capacity, not bytes used. Unavailable measurements are null. This never provisions or resumes a server.",
    },
  },
  serversCtrl.serverUsage,
);
r.post(
  "/servers/:id/ensure",
  {
    tag: "server:write",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Queue idempotent provisioning or resume of a subscribed managed Cloud server. Checks provider entitlement and preserves existing data. Docker and bare projects reuse this server. Poll server get for operation progress.",
    },
  },
  serversCtrl.ensureServer,
);
r.get(
  "/servers/:id/resize",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Preview applying a managed server's purchased capacity. Returns a revision and the projects that may restart; no billing or runtime changes. Review before resize. Disk shrinking requires migration.",
    },
  },
  serversCtrl.previewServerResize,
);
r.post(
  "/servers/:id/resize",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.resize.input,
    mcp: {
      description:
        "Apply a reviewed managed server resize with its preview revision, idempotency key and restart confirmation. Preserves container recovery checkpoints and waits for deployments. Poll server get for completion.",
    },
  },
  serversCtrl.resizeServer,
);
r.post(
  "/servers/:id/retry",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Retry this managed server's failed lifecycle operation. Reuses its provider identity and saved recovery checkpoint. Inspect the error first, then poll server get for progress.",
    },
  },
  serversCtrl.retryServerOperation,
);
r.delete(
  "/servers/:id/managed",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.removeManaged.input,
    mcp: {
      description:
        "Delete an empty managed server after its subscription has ended. Requires billing admin, explicit confirmation and an idempotency key. Refuses servers with projects; confirms provider removal before removing ownership. Project deletion never deletes this server.",
    },
  },
  serversCtrl.removeManagedServer,
);

r.get(
  "/servers/:id/network-settings",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read a managed Docker server's provider network settings. Null internetAccess means unavailable. Ports are managed by project routing; this read never starts the server.",
    },
  },
  serversCtrl.getServerNetworkSettings,
);
r.patch(
  "/servers/:id/network-settings",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.updateNetworkSettings.input,
    mcp: {
      description:
        "Change outbound internet access on a managed Docker server after reviewing current settings. Disabling it affects downloads, external APIs and builds for every project. Send expectedInternetAccess and confirm:true. Ingress, private links and edge routing remain managed by Openship and Oblien.",
    },
  },
  serversCtrl.updateServerNetworkSettings,
);

export const serverResourceRoutes = r.hono;
