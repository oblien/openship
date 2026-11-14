/** Server discovery API (docs/docker-service-discovery-plan.md, step 3 tail). */
import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./discovery.controller";

const r = secureRouter(new Hono(), { module: "discovery", basePath: "/api/discovery" });

r.get(
  "/servers/:id/discovery",
  { tag: "server:read", mcp: { description: "Read a server's discovery settings and every discovered service with its route state and TLS status." } },
  ctrl.getDiscovery,
);
r.put(
  "/servers/:id/discovery",
  { tag: "server:admin", auditHandledByOperation: true, mcp: { description: "Enable or disable server discovery. Disable schedules retirement of every applied route (they are removed, certificates retained) and expires the event watchers." } },
  ctrl.configureDiscovery,
);
r.post(
  "/servers/:id/discovery/rescan",
  { tag: "server:write", readOnly: true, mcp: { description: "Run a fresh discovery scan, route reconciliation, and route repair for this server right now, through the serialized per-server sweep queue." } },
  ctrl.rescanDiscovery,
);
r.post(
  "/servers/:id/discovery/services/:serviceKey/suppress",
  { tag: "server:write", auditHandledByOperation: true, mcp: { description: "Opt a discovered service out: it stays visible, its live route is removed outright, and no route is reconciled until re-accepted. Certificate material is retained." } },
  ctrl.suppressDiscoveryService,
);
r.post(
  "/servers/:id/discovery/services/:serviceKey/unsuppress",
  { tag: "server:write", auditHandledByOperation: true, mcp: { description: "Re-accept a suppressed discovered service; the next scan re-applies its route." } },
  ctrl.unsuppressDiscoveryService,
);
r.delete(
  "/servers/:id/discovery/services/:serviceKey",
  { tag: "server:admin", auditHandledByOperation: true, mcp: { description: "Forget a discovered service: its route is removed now and the binding deleted. The certificate record and files are retained." } },
  ctrl.forgetDiscoveryService,
);

export const discoveryRoutes = r.hono;
