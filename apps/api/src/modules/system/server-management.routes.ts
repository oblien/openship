/** Server HTTP adapters, shared by the system router and operation parity tests. */
import { Hono } from "hono";
import {
  RemoveServerInputSchema,
  ServerInstallSessionInputSchema,
  ApplyAllServerContainersInputSchema,
  ResourceIdSchema,
  CheckServerInputSchema,
  ServerComponentInputSchema,
  InstallServerComponentsInputSchema,
  ServerInstallResponseInputSchema,
  AgentExecBody,
  CreateServerInputSchema,
  UpdateServerInputSchema,
  UpdateServerRateLimitSchema,
  SaveServerTunnelInputSchema,
  CreateClusterInputSchema,
  UpdateClusterInputSchema,
  ServerClusterCollectionSchemas,
  SetupClusterRuntimeInputSchema,
  ChangeClusterRuntimeInputSchema,
  NetworkCollectionSchemas,
  UpdateNetworkInputSchema,
  CreateComputeClusterInputSchema,
  UpdateComputeClusterInputSchema,
  ComputeClusterCollectionSchemas,
  ClusterStorageCollectionSchemas,
} from "@repo/contracts";
import { Type } from "@sinclair/typebox";
import * as serverCheck from "./server-check.controller";
import { secureRouter } from "../../lib/secure-router";
import * as serversCtrl from "./servers.controller";
import * as rateLimit from "./rate-limit.controller";
import * as serverContainers from "./server-containers.controller";
import * as serverModules from "./server-modules.controller";
import * as tunnels from "./tunnels.controller";
import * as clusters from "./server-clusters.controller";
import {
  networks,
  computeClusters,
  clusterRuntime,
  clusterStorage,
} from "./infrastructure-resources.controller";

const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system", localOnly: true });

// Organization-owned infrastructure. Shared operations enforce fleet-wide access
// and authorize every selected server, including calls made through the native SDK.
const fleetRead = {
  tag: "server:read",
  collection: true,
  authorizationHandledByOperation: true,
} as const;
const fleetAdmin = {
  tag: "server:admin",
  collection: true,
  authorizationHandledByOperation: true,
  auditHandledByOperation: true,
} as const;
r.get(
  "/compute-clusters/:id/storage",
  {
    ...fleetRead,
    mcp: {
      description:
        "Read shared-storage setup, capacity and saved progress. Use observe=true for current disk and volume health.",
    },
  },
  clusterStorage.get,
);
r.get(
  "/compute-clusters/:id/storage/stream",
  {
    ...fleetRead,
    mcpExcluded: "SSE progress transport; read the JSON storage status through MCP.",
  },
  clusterStorage.events,
);
r.post(
  "/compute-clusters/:id/storage",
  {
    ...fleetAdmin,
    body: Type.Omit(ClusterStorageCollectionSchemas.setupClusterStorage.input, ["clusterId"]),
    mcp: {
      description:
        "Enable persistent and shared storage on reviewed cluster servers and dedicated empty directories. Installs prerequisites without formatting disks. Reuse requestId after a lost response and follow saved progress.",
    },
  },
  clusterStorage.setup,
);
r.post(
  "/compute-clusters/:id/storage/retry",
  {
    ...fleetAdmin,
    body: Type.Omit(ClusterStorageCollectionSchemas.retryClusterStorage.input, ["clusterId"]),
    mcp: {
      description:
        "Resume failed or interrupted storage setup/removal using its latest sequence. Inspect the error before retrying.",
    },
  },
  clusterStorage.retry,
);
r.patch(
  "/compute-clusters/:id/storage/backup",
  {
    ...fleetAdmin,
    body: Type.Omit(ClusterStorageCollectionSchemas.configureClusterStorageBackup.input, [
      "clusterId",
    ]),
    mcp: {
      description:
        "Configure an existing external backup destination for shared files. Uses the current storage sequence and preserves an already configured destination so archives stay recoverable.",
    },
  },
  clusterStorage.backup,
);
r.delete(
  "/compute-clusters/:id/storage",
  {
    ...fleetAdmin,
    body: Type.Omit(ClusterStorageCollectionSchemas.removeClusterStorage.input, ["clusterId"]),
    mcp: {
      description:
        "Remove an empty shared-storage installation using its latest sequence. Refuses persistent or retained volumes and preserves external backup archives.",
    },
  },
  clusterStorage.remove,
);
// Both route generations share the durable setup handlers and request schemas.
// Legacy URLs remain aliases for networks, including saved operation streams.
for (const [base, prefix] of [
  ["/networks", ""],
  ["/clusters", "network-"],
] as const) {
  const operations = `${base}/${prefix}operations`;
  const preparations = `${base}/${prefix}preparations`;
  r.post(
    `${base}/${prefix}plans`,
    {
      ...fleetAdmin,
      body: ServerClusterCollectionSchemas.planManagedNetwork.input,
      mcp:
        base === "/networks"
          ? {
              description:
                "Plan an Openship-managed WireGuard network change without applying it. Returns an expiring planHash, host changes and firewall requirements. Reuse requestId for the same intent; inspect the plan before calling operations/apply.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.planManaged,
  );
  r.get(
    operations + "/:operationId",
    {
      ...fleetRead,
      mcp:
        base === "/networks"
          ? {
              description:
                "Read a managed-network operation, its planHash, sequence, per-host steps/logs, verification report and errors. Poll while applying, verifying, committing or rolling_back. A saved plan is not an applied network.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.managedOperation,
  );
  r.get(
    operations + "/:operationId/stream",
    {
      ...fleetRead,
      mcpExcluded:
        "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
    },
    clusters.managedOperationEvents,
  );
  r.delete(
    operations + "/:operationId",
    {
      ...fleetAdmin,
      body: Type.Omit(ServerClusterCollectionSchemas.discardManagedNetworkPlan.input, [
        "operationId",
      ]),
      mcp:
        base === "/networks"
          ? {
              description:
                "Discard an unapplied managed-network plan using its current planHash. Refuses active or partially applied plans; inspect the operation and use its rollback action when host cleanup is required.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.discardPlan,
  );
  r.delete(
    operations + "/:operationId/members/:serverId",
    {
      ...fleetAdmin,
      body: Type.Omit(ServerClusterCollectionSchemas.removeManagedNetworkOperationMember.input, [
        "operationId",
        "serverId",
      ]),
      mcp:
        base === "/networks"
          ? {
              description:
                "Remove a server from an unfinished managed-network operation using its planHash and sequence. Reconciles owned partial changes and returns a replacement preparation/plan; inspect it before applying.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.removeOperationMember,
  );
  r.post(
    operations + "/:operationId/apply",
    {
      ...fleetAdmin,
      body: Type.Omit(ServerClusterCollectionSchemas.applyManagedNetwork.input, ["operationId"]),
      mcp:
        base === "/networks"
          ? {
              description:
                "Apply, resume or roll back the exact managed-network plan identified by planHash. Review host changes and provider firewall requirements first. Returns accepted progress; poll the operation until it settles and inspect failures before retrying.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.applyManaged,
  );
  r.post(
    preparations,
    {
      ...fleetAdmin,
      body: ServerClusterCollectionSchemas.prepareManagedNetwork.input,
      mcp:
        base === "/networks"
          ? {
              description:
                "Start durable preparation for managed WireGuard networking: check hosts and install missing prerequisites, then produce a reviewed plan. Reuse requestId after a lost response. Poll the preparation; when ready, inspect its operationId and plan before applying networking.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.prepareManaged,
  );
  r.get(
    preparations,
    {
      ...fleetRead,
      mcp:
        base === "/networks"
          ? {
              description:
                "List saved managed-network preparations so interrupted setup can be found without starting another operation.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.managedPreparations,
  );
  r.get(
    preparations + "/:preparationId",
    {
      ...fleetRead,
      mcp:
        base === "/networks"
          ? {
              description:
                "Read a managed-network preparation’s status, sequence, per-host steps/logs and errors. When ready, follow operationId to inspect the generated plan. replacementPreparationId and cleanupOperationId identify any follow-up work.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.managedPreparation,
  );
  r.get(
    preparations + "/:preparationId/stream",
    {
      ...fleetRead,
      mcpExcluded:
        "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
    },
    clusters.preparationEvents,
  );
  r.patch(
    preparations + "/:preparationId/connections",
    {
      ...fleetAdmin,
      body: Type.Omit(ServerClusterCollectionSchemas.reviseManagedNetworkAccess.input, [
        "preparationId",
      ]),
      mcp:
        base === "/networks"
          ? {
              description:
                "Revise permitted server-to-server connections for an unfinished managed-network preparation using its latest sequence and a new requestId. Returns replacement preparation; inspect and apply its new plan. k3s requires bidirectional access among all selected members.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.reviseManagedAccess,
  );
  r.delete(
    preparations + "/:preparationId",
    {
      ...fleetAdmin,
      body: Type.Omit(ServerClusterCollectionSchemas.discardManagedNetworkPreparation.input, [
        "preparationId",
      ]),
      mcp:
        base === "/networks"
          ? {
              description:
                "Cancel or discard an unfinished managed-network preparation using its latest sequence. Follow any returned cleanupOperationId until owned host changes have been cleaned up; a cancellation request alone does not prove cleanup finished.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.discardPreparation,
  );
  r.delete(
    preparations + "/:preparationId/members/:serverId",
    {
      ...fleetAdmin,
      body: Type.Omit(ServerClusterCollectionSchemas.removeManagedNetworkPreparationMember.input, [
        "preparationId",
        "serverId",
      ]),
      mcp:
        base === "/networks"
          ? {
              description:
                "Remove a server from an unfinished managed-network preparation using the latest sequence and a new requestId. Returns replacement setup state and any required cleanup; this is not live k3s worker removal.",
            }
          : undefined,
      mcpExcluded: "Compatibility alias for /api/system/networks; use the canonical network tools.",
    },
    clusters.removePreparationMember,
  );
  r.get(
    base + "/stream",
    {
      ...fleetRead,
      mcpExcluded:
        "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
    },
    clusters.clusterEvents,
  );
}

r.get(
  "/clusters/capabilities",
  {
    ...fleetRead,
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.capabilities,
);
r.get(
  "/clusters",
  {
    ...fleetRead,
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.list,
);
r.get(
  "/clusters/:id",
  {
    ...fleetRead,
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.get,
);
r.post(
  "/clusters",
  {
    ...fleetAdmin,
    body: CreateClusterInputSchema,
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.create,
);
r.patch(
  "/clusters/:id",
  {
    ...fleetAdmin,
    body: Type.Omit(UpdateClusterInputSchema, ["clusterId"]),
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.update,
);
r.post(
  "/clusters/:id/verify",
  {
    ...fleetAdmin,
    body: Type.Omit(ServerClusterCollectionSchemas.verifyCluster.input, ["clusterId"]),
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.verify,
);
r.delete(
  "/clusters/:id",
  {
    ...fleetAdmin,
    body: Type.Omit(ServerClusterCollectionSchemas.removeCluster.input, ["clusterId"]),
    mcpExcluded:
      "Compatibility private-network API. Use /api/system/networks; compute clusters live at /api/system/compute-clusters.",
  },
  clusters.remove,
);
r.get(
  "/networks/capabilities",
  {
    ...fleetRead,
    mcp: {
      description:
        "Check whether private networking is available, whether this credential may manage the server fleet, supported providers and network modes, and member limits. Start network or cluster setup here.",
    },
  },
  networks.capabilities,
);
r.get(
  "/networks",
  {
    ...fleetRead,
    mcp: {
      description:
        "List private networks with members, saved verification and any managed setup operation. Private networks provide connectivity; compute clusters and their k3s runtime are separate resources.",
    },
  },
  networks.list,
);
r.get(
  "/networks/:id",
  {
    ...fleetRead,
    mcp: {
      description:
        "Read a private network, its current revision, member addresses, verification report and managed operation. Poll after verification; a saved report is dated evidence, not continuous monitoring.",
    },
  },
  networks.get,
);
r.post(
  "/networks",
  {
    ...fleetAdmin,
    body: CreateClusterInputSchema,
    mcp: {
      description:
        "Register an existing native private network using discovered private interfaces and distinct IPv4 addresses. This does not provision a provider network. Reuse requestId after a lost response, then verify the saved network.",
    },
  },
  networks.create,
);
r.patch(
  "/networks/:id",
  {
    ...fleetAdmin,
    body: Type.Omit(UpdateNetworkInputSchema, ["networkId"]),
    mcp: {
      description:
        "Replace a native private network configuration using its current revision. Existing runtime dependencies block membership changes. Verify again after changing the configuration.",
    },
  },
  networks.update,
);
r.post(
  "/networks/:id/verify",
  {
    ...fleetAdmin,
    body: Type.Omit(NetworkCollectionSchemas.verifyNetwork.input, ["networkId"]),
    mcp: {
      description:
        "Start bidirectional private-network verification for the current revision. Poll the network detail until verification finishes and inspect its peer report. Provider firewall rules must already permit the probe traffic.",
    },
  },
  networks.verify,
);
r.delete(
  "/networks/:id",
  {
    ...fleetAdmin,
    body: Type.Omit(NetworkCollectionSchemas.removeNetwork.input, ["networkId"]),
    mcp: {
      description:
        "Remove a native private-network record using its current revision. Dependencies block removal. For an Openship-managed WireGuard network, prepare and apply a removal plan first; this call does not force-delete host networking.",
    },
  },
  networks.remove,
);

r.get(
  "/compute-clusters",
  {
    ...fleetRead,
    mcp: {
      description:
        "List compute clusters, their server membership, selected private network and saved k3s readiness. A compute cluster does not become ready for deployments until runtime setup succeeds.",
    },
  },
  computeClusters.list,
);
r.get(
  "/compute-clusters/:id/runtime",
  {
    ...fleetRead,
    mcp: {
      description:
        "Read saved k3s setup or removal progress, including status, sequence, per-host steps, logs and errors; returns null before setup. Poll this endpoint after starting work. Reading never starts or retries an operation.",
    },
  },
  clusterRuntime.get,
);
r.get(
  "/compute-clusters/:id/runtime/stream",
  {
    ...fleetRead,
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  clusterRuntime.events,
);
r.post(
  "/compute-clusters/:id/runtime",
  {
    ...fleetAdmin,
    body: Type.Omit(SetupClusterRuntimeInputSchema, ["clusterId"]),
    mcp: {
      description:
        "Start durable k3s setup on this compute cluster with its current revision and a stable requestId. Checks private connectivity and host prerequisites before installation. Returns accepted progress, not completion; poll runtime until ready, failed or interrupted. Requires fleet administration.",
    },
  },
  clusterRuntime.setup,
);
r.post(
  "/compute-clusters/:id/runtime/retry",
  {
    ...fleetAdmin,
    body: Type.Omit(ChangeClusterRuntimeInputSchema, ["clusterId"]),
    mcp: {
      description:
        "Resume a failed or interrupted k3s setup or removal using the latest runtime sequence. Reuses the saved version, ownership and operation intent. Inspect errors first and poll runtime for completion; do not retry merely because a response was lost.",
    },
  },
  clusterRuntime.retry,
);
r.delete(
  "/compute-clusters/:id/runtime",
  {
    ...fleetAdmin,
    body: Type.Omit(ChangeClusterRuntimeInputSchema, ["clusterId"]),
    mcp: {
      description:
        "Start removal of the owned k3s installation using the latest runtime sequence. Refuses attached projects, database data or foreign resources. Poll runtime until removed; failures are resumable. Retains Docker workloads and private networking.",
    },
  },
  clusterRuntime.remove,
);
r.get(
  "/compute-clusters/:id",
  {
    ...fleetRead,
    mcp: {
      description:
        "Read a compute cluster and its current revision, server IDs, private network and saved runtime readiness. Use this revision when setting up k3s or changing the cluster.",
    },
  },
  computeClusters.get,
);
r.post(
  "/compute-clusters",
  {
    ...fleetAdmin,
    body: CreateComputeClusterInputSchema,
    mcp: {
      description:
        "Create a compute cluster from registered servers on one private network. Reuse requestId for the same intent after a lost response. This saves membership; start its runtime setup next.",
    },
  },
  computeClusters.create,
);
r.patch(
  "/compute-clusters/:id",
  {
    ...fleetAdmin,
    body: Type.Omit(UpdateComputeClusterInputSchema, ["clusterId"]),
    mcp: {
      description:
        "Update compute-cluster membership and network using the current revision. A runtime must be removed before changing its members; this is not live worker joining or draining.",
    },
  },
  computeClusters.update,
);
r.delete(
  "/compute-clusters/:id",
  {
    ...fleetAdmin,
    body: Type.Omit(ComputeClusterCollectionSchemas.removeComputeCluster.input, ["clusterId"]),
    mcp: {
      description:
        "Delete an empty compute-cluster record using its current revision. Remove dependent projects, databases and the owned runtime first. Private networks and registered servers are retained.",
    },
  },
  computeClusters.remove,
);
r.post(
  "/servers/:id/network/inspect",
  {
    tag: "server:admin",
    readOnly: true,
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Inspect this server’s actual network interfaces, private IPv4 addresses, MTUs and machine identity over SSH. Does not change networking. Use the observation to register a native private network.",
    },
  },
  clusters.inspect,
);

r.get(
  "/servers/:id/tunnels",
  {
    tag: "server:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "List saved SSH port-forwarding tunnels for this server and their current state. Tunnels run from this Openship controller, not from the MCP client.",
    },
  },
  tunnels.listTunnels,
);
r.post(
  "/servers/:id/tunnels",
  {
    tag: "server:write",
    body: SaveServerTunnelInputSchema,
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Save an SSH port-forwarding tunnel configuration. Start it separately; its local bind address belongs to the Openship controller.",
    },
  },
  tunnels.saveTunnel,
);
r.post(
  "/servers/:id/tunnels/:tunnelId/start",
  {
    tag: "server:write",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Start this saved tunnel on the Openship controller and return its local address. Read the tunnel list to inspect state.",
    },
  },
  tunnels.startTunnelHandler,
);
r.post(
  "/servers/:id/tunnels/:tunnelId/stop",
  {
    tag: "server:write",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description: "Stop this controller-side SSH tunnel while retaining its saved configuration.",
    },
  },
  tunnels.stopTunnelHandler,
);
r.delete(
  "/servers/:id/tunnels/:tunnelId",
  {
    tag: "server:write",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Stop and delete this saved SSH tunnel. Connections using its local port will close.",
    },
  },
  tunnels.deleteTunnel,
);




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
//    the permission resource; handlers hard-guard cloud + org-scope. ──
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
    query: Type.Object(
      { serverId: ResourceIdSchema, ...ServerInstallSessionInputSchema.properties },
      { additionalProperties: false },
    ),
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

export const serverManagementRoutes = r.hono;
