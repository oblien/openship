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
import * as managedCtrl from "./server-managed.controller";
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
    query: Type.Object({ serverId: ResourceIdSchema }, { additionalProperties: false }),
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
    query: Type.Object({
      details: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
    }, { additionalProperties: false }),
    mcp: {
      description:
        "Read a managed Docker server's provider network settings. Add details=true for outbound rules, IP diagnostics and the revision required to edit rules. Null internetAccess means unavailable. Ports are managed by project routing; this read never starts the server.",
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
        "Change outbound internet access and optional egress host allowlist on a managed Docker server after reviewing current settings. Egress changes also require expectedRevision from the network read. Disabling it affects downloads, external APIs and builds for every project. Send expectedInternetAccess and confirm:true. Ingress, private links and edge routing remain managed by Openship and Oblien.",
    },
  },
  serversCtrl.updateServerNetworkSettings,
);

r.get(
  "/servers/:id/managed/info",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Read the selected managed server image, operating system, lifecycle and actual allocation. Does not start the VM or return its raw configuration.",
    },
  },
  managedCtrl.managedInfo,
);

r.post(
  "/servers/:id/managed/boot-logs",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.managedBootLogs.input,
    mcp: {
      description:
        "Read a bounded tail of managed server boot logs. Requires server admin; logs may contain application output.",
    },
  },
  managedCtrl.managedBootLogs,
);

r.get(
  "/servers/:id/managed/ssh",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Read SSH enablement and public connection instructions for this managed server. Never returns passwords.",
    },
  },
  managedCtrl.managedSshStatus,
);

r.patch(
  "/servers/:id/managed/ssh",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.setManagedSsh.input,
    mcp: {
      description:
        "Enable or disable SSH with explicit confirmation and expected enablement. Changes all SSH users on this server.",
    },
  },
  managedCtrl.setManagedSsh,
);

r.put(
  "/servers/:id/managed/ssh/key",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.setManagedSshKey.input,
    mcp: {
      description:
        "Replace the root authorized public key on this server. Accepts one OpenSSH public key; never a private key. Requires confirmation.",
    },
  },
  managedCtrl.setManagedSshKey,
);

r.put(
  "/servers/:id/managed/ssh/password",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.setManagedSshPassword.input,
    mcp: {
      description:
        "Set the root SSH password on this managed server. Requires confirmation. The password is never returned or audited.",
    },
  },
  managedCtrl.setManagedSshPassword,
);

r.post(
  "/servers/:id/managed/ssh/connection",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.managedSshConnection.input,
    mcp: {
      description:
        "Issue a short-lived SSH connection for this managed server. Requires server admin and confirmation. Treat its password as a secret.",
    },
  },
  managedCtrl.managedSshConnection,
);

r.get(
  "/servers/:id/managed/runtime-api",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Read the managed server Runtime API status without enabling it or returning a token.",
    },
  },
  managedCtrl.managedRuntimeStatus,
);

r.post(
  "/servers/:id/managed/runtime-api/enable",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.enableManagedRuntime.input,
    mcp: {
      description:
        "Enable the Runtime API used by Openship for deployments and server management. Requires server admin and active server entitlement.",
    },
  },
  managedCtrl.enableManagedRuntime,
);

r.post(
  "/servers/:id/managed/runtime-api/credential",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.managedRuntimeCredential.input,
    mcp: {
      description:
        "Reveal the current workspace-only Runtime API credential. Requires server admin and confirmation. Does not enable the service or issue an account/namespace token.",
    },
  },
  managedCtrl.managedRuntimeCredential,
);

r.post(
  "/servers/:id/managed/runtime-api/rotate",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.rotateManagedRuntimeCredential.input,
    mcp: {
      description:
        "Rotate the Runtime API credential after reviewing the current revision. Invalidates prior tokens and sessions. A stale revision cannot repeat a successful rotation.",
    },
  },
  managedCtrl.rotateManagedRuntimeCredential,
);

r.get(
  "/servers/:id/managed/workloads",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "List native managed processes with live status, capped at 100 entries. Distinguishes manual, project and system workloads; does not return environments or commands.",
    },
  },
  managedCtrl.managedWorkloads,
);

r.post(
  "/servers/:id/managed/workloads/logs",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.managedWorkloadLogs.input,
    mcp: {
      description:
        "Read bounded logs for a process on this managed server. Requires server admin. Process ID is scoped to the server.",
    },
  },
  managedCtrl.managedWorkloadLogs,
);

r.post(
  "/servers/:id/managed/workloads",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.createManagedWorkload.input,
    mcp: {
      description:
        "Create a stopped manual native process on this server. Reuse the same idempotency key after an uncertain response. Commands and environment are admin-only and not audited. Start it explicitly after creation.",
    },
  },
  managedCtrl.createManagedWorkload,
);

r.post(
  "/servers/:id/managed/workloads/control",
  {
    tag: "server:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: ServerResourceSchemas.controlManagedWorkload.input,
    mcp: {
      description:
        "Start, stop or delete a manual process created by the server controls. Requires confirmation. Project and platform processes must use their own lifecycle controls.",
    },
  },
  managedCtrl.controlManagedWorkload,
);

export const serverResourceRoutes = r.hono;
