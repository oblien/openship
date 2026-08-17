/**
 * Agent routes — mounted at /api/servers.
 *
 * localOnly / operator only (not mounted in CLOUD_MODE). Enroll/status/revoke
 * are session-auth. Report is HMAC-signed by the agent.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./server-agent.controller";

const r = secureRouter(new Hono(), {
  module: "server-agent",
  basePath: "/api/servers",
  localOnly: true,
});

r.get("/:id/agent", { tag: "server:read" }, ctrl.agentStatus);
r.post("/:id/agent/enroll", { tag: "server:admin" }, ctrl.enrollAgent);
r.delete("/:id/agent", { tag: "server:admin" }, ctrl.revokeAgent);
r.public(
  "post",
  "/:id/agent/report",
  { reason: "HMAC-signed agent heartbeat — no user session; envelope is verified against the enrolled secret" },
  ctrl.agentReport,
);

export const serverAgentRoutes = r.hono;
