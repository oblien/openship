/** Server HTTP adapters, shared by the system router and operation parity tests. */
import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import { ResourceIdSchema, CheckServerInputSchema, ServerComponentInputSchema, InstallServerComponentsInputSchema, ServerInstallResponseInputSchema } from "@repo/contracts";
import * as serverCheck from "./server-check.controller";
import { AgentExecBody, CreateServerInputSchema, UpdateServerInputSchema, UpdateServerRateLimitSchema } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as serversCtrl from "./servers.controller";
import * as rateLimit from "./rate-limit.controller";
import * as serverContainers from "./server-containers.controller";
import * as serverModules from "./server-modules.controller";
import * as tunnels from "./tunnels.controller";
import { SaveServerTunnelInputSchema } from "@repo/contracts";
import { CreateClusterInputSchema, UpdateClusterInputSchema, ServerClusterCollectionSchemas } from "@repo/contracts";
import * as clusters from "./server-clusters.controller";
import { networks, computeClusters } from "./infrastructure-resources.controller";
import { NetworkCollectionSchemas, UpdateNetworkInputSchema, CreateComputeClusterInputSchema, UpdateComputeClusterInputSchema, ComputeClusterCollectionSchemas } from "@repo/contracts";

const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system", localOnly: true });

// Organization-owned infrastructure. Shared operations enforce fleet-wide access
// and authorize every selected server, including calls made through the native SDK.
const fleetRead = { tag: "server:read", collection: true, authorizationHandledByOperation: true } as const;
const fleetAdmin = { tag: "server:admin", collection: true, authorizationHandledByOperation: true, auditHandledByOperation: true } as const;
// Both route generations share the durable setup handlers and request schemas.
// Legacy URLs remain aliases for networks, including saved operation streams.
for (const [base, prefix] of [["/networks", ""], ["/clusters", "network-"]] as const) {
  const operations = `${base}/${prefix}operations`;
  const preparations = `${base}/${prefix}preparations`;
  r.post(`${base}/${prefix}plans`, { ...fleetAdmin, body: ServerClusterCollectionSchemas.planManagedNetwork.input }, clusters.planManaged);
  r.get(operations + "/:operationId", fleetRead, clusters.managedOperation);
  r.get(operations + "/:operationId/stream", fleetRead, clusters.managedOperationEvents);
  r.delete(operations + "/:operationId", {
    ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.discardManagedNetworkPlan.input, ["operationId"]),
  }, clusters.discardPlan);
  r.delete(operations + "/:operationId/members/:serverId", {
    ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.removeManagedNetworkOperationMember.input, ["operationId", "serverId"]),
  }, clusters.removeOperationMember);
  r.post(operations + "/:operationId/apply", {
    ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.applyManagedNetwork.input, ["operationId"]),
  }, clusters.applyManaged);
  r.post(preparations, { ...fleetAdmin, body: ServerClusterCollectionSchemas.prepareManagedNetwork.input }, clusters.prepareManaged);
  r.get(preparations, fleetRead, clusters.managedPreparations);
  r.get(preparations + "/:preparationId", fleetRead, clusters.managedPreparation);
  r.get(preparations + "/:preparationId/stream", fleetRead, clusters.preparationEvents);
  r.patch(preparations + "/:preparationId/connections", {
    ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.reviseManagedNetworkAccess.input, ["preparationId"]),
  }, clusters.reviseManagedAccess);
  r.delete(preparations + "/:preparationId", {
    ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.discardManagedNetworkPreparation.input, ["preparationId"]),
  }, clusters.discardPreparation);
  r.delete(preparations + "/:preparationId/members/:serverId", {
    ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.removeManagedNetworkPreparationMember.input, ["preparationId", "serverId"]),
  }, clusters.removePreparationMember);
  r.get(base + "/stream", fleetRead, clusters.clusterEvents);
}

r.get("/clusters/capabilities", fleetRead, clusters.capabilities);
r.get("/clusters", fleetRead, clusters.list);
r.get("/clusters/:id", fleetRead, clusters.get);
r.post("/clusters", { ...fleetAdmin, body: CreateClusterInputSchema }, clusters.create);
r.patch("/clusters/:id", { ...fleetAdmin, body: Type.Omit(UpdateClusterInputSchema, ["clusterId"]) }, clusters.update);
r.post("/clusters/:id/verify", { ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.verifyCluster.input, ["clusterId"]) }, clusters.verify);
r.delete("/clusters/:id", { ...fleetAdmin, body: Type.Omit(ServerClusterCollectionSchemas.removeCluster.input, ["clusterId"]) }, clusters.remove);
r.get("/networks/capabilities", fleetRead, networks.capabilities);
r.get("/networks", fleetRead, networks.list);
r.get("/networks/:id", fleetRead, networks.get);
r.post("/networks", { ...fleetAdmin, body: CreateClusterInputSchema }, networks.create);
r.patch("/networks/:id", { ...fleetAdmin, body: Type.Omit(UpdateNetworkInputSchema, ["networkId"]) }, networks.update);
r.post("/networks/:id/verify", { ...fleetAdmin, body: Type.Omit(NetworkCollectionSchemas.verifyNetwork.input, ["networkId"]) }, networks.verify);
r.delete("/networks/:id", { ...fleetAdmin, body: Type.Omit(NetworkCollectionSchemas.removeNetwork.input, ["networkId"]) }, networks.remove);

r.get("/compute-clusters", fleetRead, computeClusters.list);
r.get("/compute-clusters/:id", fleetRead, computeClusters.get);
r.post("/compute-clusters", { ...fleetAdmin, body: CreateComputeClusterInputSchema }, computeClusters.create);
r.patch("/compute-clusters/:id", { ...fleetAdmin, body: Type.Omit(UpdateComputeClusterInputSchema, ["clusterId"]) }, computeClusters.update);
r.delete("/compute-clusters/:id", { ...fleetAdmin, body: Type.Omit(ComputeClusterCollectionSchemas.removeComputeCluster.input, ["clusterId"]) }, computeClusters.remove);
r.post("/servers/:id/network/inspect", { tag: "server:admin", readOnly: true, authorizationHandledByOperation: true }, clusters.inspect);

r.get("/servers/:id/tunnels", { tag: "server:read", authorizationHandledByOperation: true }, tunnels.listTunnels);
r.post("/servers/:id/tunnels", { tag: "server:write", body: SaveServerTunnelInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true }, tunnels.saveTunnel);
r.post("/servers/:id/tunnels/:tunnelId/start", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, tunnels.startTunnelHandler);
r.post("/servers/:id/tunnels/:tunnelId/stop", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, tunnels.stopTunnelHandler);
r.delete("/servers/:id/tunnels/:tunnelId", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, tunnels.deleteTunnel);

r.get("/servers", { tag: "server:list" }, serversCtrl.listServers);
r.get("/servers/:id", { tag: "server:read" }, serversCtrl.getServer);
r.get("/servers/:id/reachability", { tag: "server:read" }, serversCtrl.probeReachability);
r.get("/servers/:id/infrastructure", { tag: "server:read", authorizationHandledByOperation: true }, serversCtrl.getInfrastructure);
// Read-only blast-radius snapshot for the removal confirm: which projects and apps
// this box currently runs, and which server-scoped records go with it.
r.get("/servers/:id/deletion-preview", { tag: "server:read" }, serversCtrl.serverDeletionPreview);
// Create has no :id in the URL — org scope comes from the request and the
// row is created in the active org. collection:true keeps the permission
// middleware from demanding a (nonexistent) :id param.
r.post("/servers", { tag: "server:write", collection: true, body: CreateServerInputSchema, auditHandledByOperation: true }, serversCtrl.createServer);
r.patch("/servers/:id", { tag: "server:write", body: UpdateServerInputSchema, auditHandledByOperation: true }, serversCtrl.updateServer);
r.delete("/servers/:id", { tag: "server:admin", auditHandledByOperation: true }, serversCtrl.deleteServer);
// Host exec. `server:admin` on the id, so a {server,<id>,[admin]} grant confines an
// agent to this one box — the per-resource scope the jobs-based workaround could not
// express. MCP-exposed deliberately: this is the sanctioned agent execution point.
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

/* ── Per-server rate limiting (OpenResty level) ─────────────────── */
r.get("/servers/:id/rate-limit", { tag: "server:read" }, rateLimit.getRateLimit);
r.patch("/servers/:id/rate-limit", { tag: "server:admin", body: UpdateServerRateLimitSchema, auditHandledByOperation: true }, rateLimit.updateRateLimit);

// ── Native-module versioning + migration (OpenResty, …). The `:id` server is
//    the permission resource; handlers hard-guard cloud + org-scope. ──
r.get("/servers/:id/modules", { tag: "server:read" }, serverModules.listServerModules);
r.post("/servers/:id/modules/scan", { tag: "server:write", auditHandledByOperation: true }, serverModules.scanServerModules);
r.post("/servers/:id/modules/:module/apply", { tag: "server:write", auditHandledByOperation: true }, serverModules.applyServerModuleUpdate);

r.post("/servers/:id/ports/scan", { tag: "server:read", readOnly: true }, serverCheck.scanExposedPorts);
r.post("/test-connection", { tag: "server:write", collection: true, body: CreateServerInputSchema, auditHandledByOperation: true }, serverCheck.testConnection);
r.post("/check", { tag: "server:admin", body: Type.Object({ ...CheckServerInputSchema.properties, serverId: ResourceIdSchema }, { additionalProperties: false }), authorizationHandledByOperation: true, auditHandledByOperation: true }, serverCheck.checkServer);
r.post("/install", { tag: "server:admin", authorizationHandledByOperation: true, body: Type.Object({ ...ServerComponentInputSchema.properties, serverId: ResourceIdSchema }, { additionalProperties: false }), auditHandledByOperation: true }, serverCheck.installComponent);
r.post("/remove", { tag: "server:admin", authorizationHandledByOperation: true, body: Type.Object({ ...ServerComponentInputSchema.properties, serverId: ResourceIdSchema }, { additionalProperties: false }), auditHandledByOperation: true }, serverCheck.removeComponent);
r.post("/install/stream", { tag: "server:admin", authorizationHandledByOperation: true, body: Type.Object({ ...InstallServerComponentsInputSchema.properties, serverId: ResourceIdSchema }, { additionalProperties: false }), auditHandledByOperation: true }, serverCheck.installStream);
r.post("/install/respond", { tag: "server:admin", authorizationHandledByOperation: true, body: ServerInstallResponseInputSchema, auditHandledByOperation: true }, serverCheck.installRespond);
r.get("/install/stream", { tag: "server:read", authorizationHandledByOperation: true }, serverCheck.attachInstallStream);
r.get("/install/session", { tag: "server:read", authorizationHandledByOperation: true }, serverCheck.getInstallSession);
r.get("/monitor/stream", { tag: "server:read", authorizationHandledByOperation: true }, serverCheck.monitorStream);

// ── Managed CONTAINER versioning (edge / mail images pinned to APP_VERSION).
//    Same `:id`-server permission resource + cloud/org guards as modules; apply
//    STREAMS the rollback-guarded image swap. ──
// Org-wide drift count for the home nudge — no :id, so collection:true scopes
// the permission check to the active org (like /install/stream, /monitor/stream)
// instead of demanding a server param.
r.get("/containers/behind", { tag: "server:read", collection: true }, serverContainers.containersBehind);
r.get("/containers/issues", { tag: "server:read", collection: true }, serverContainers.containerIssues);
// Global infra view — every server × component. No :id, so collection:true scopes
// the check to the active org (same as /containers/behind). Scan is detect-only.
r.get("/containers", { tag: "server:read", collection: true }, serverContainers.listAllContainers);
// Live progress for the fleet view: what's queued/running right now (cached rows ×
// in-memory sessions) plus what just settled, which is the only place an outcome
// lives — a finished row clears its drift and its in-progress flag together.
r.get("/containers/applying", { tag: "server:read", collection: true }, serverContainers.listApplyingContainers);
r.post("/containers/scan", { tag: "server:write", collection: true, auditHandledByOperation: true }, serverContainers.scanAllContainers);
// Fleet bulk apply — targets are derived from the cache server-side, so the body
// only carries which intents to run ("update" swaps, "repair" restarts).
r.post("/containers/apply-all", { tag: "server:write", collection: true, auditHandledByOperation: true }, serverContainers.applyAllContainers);
r.get("/servers/:id/containers", { tag: "server:read" }, serverContainers.listServerContainers);
r.post("/servers/:id/containers/scan", { tag: "server:write", auditHandledByOperation: true }, serverContainers.scanServerContainers);
r.post("/servers/:id/containers/:component/apply/stream", { tag: "server:write", auditHandledByOperation: true }, serverContainers.applyServerContainerStream);
// Read-only siblings of the POST apply stream, for page reloads: /session hands
// back a running swap's id, /stream (GET) re-attaches to it. Neither can start a
// run, so they stay on server:read while the POST keeps server:write.
r.get("/servers/:id/containers/:component/apply/session", { tag: "server:read" }, serverContainers.getServerContainerApplySession);
r.get("/servers/:id/containers/:component/apply/stream", { tag: "server:read" }, serverContainers.attachServerContainerStream);


export const serverManagementRoutes = r.hono;
