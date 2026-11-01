import { Hono } from "hono";
import { requireRole } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as local from "./cloud-local.controller";

/** Local-only cloud routes. */
export const cloudLocalRoutes = new Hono();
const r = secureRouter(cloudLocalRoutes, {
  module: "cloud-local",
  basePath: "/api/cloud",
  mcpExcluded: "Internal Cloud relay or browser credential handoff. Use the authenticated project, domain, GitHub, analytics and Cloud status tools instead.",
  localOnly: true,
});

// Disconnect + connect-finalize take over the org's cloud bearer —
// owner role only. A cloud:admin grant alone isn't enough.
r.post("/disconnect", { tag: "cloud:admin" }, requireRole("owner"), local.disconnect);
r.post("/connect-finalize", { tag: "cloud:admin" }, requireRole("owner"), local.connectFinalize);
r.get("/status", { tag: "cloud:read", mcp: { description: "Openship Cloud connection status for this instance." } }, local.status);
