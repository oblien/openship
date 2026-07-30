/** Docker Swarm inspection routes — mounted at /api/swarm on self-hosted instances only. */

import { Hono } from "hono";
import { localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./swarm.controller";
import * as observe from "./swarm-observe.controller";

const r = secureRouter(new Hono(), {
  module: "swarm",
  basePath: "/api/swarm",
  ids: { server: "serverId" },
});

r.use("*", localOnly);

// No MCP metadata: these targets expose live infrastructure topology and the
// experimental API has not been reviewed as an MCP capability.
r.get("/:serverId/probe", { tag: "server:read", readOnly: true }, ctrl.probe);
r.get("/:serverId/summary", { tag: "server:read", readOnly: true }, ctrl.summary);
r.get("/:serverId/nodes", { tag: "server:read", readOnly: true }, ctrl.nodes);
r.get("/:serverId/stacks", { tag: "server:read", readOnly: true }, ctrl.stacks);
r.get("/:serverId/stacks/:stackName", { tag: "server:read", readOnly: true }, ctrl.stack);
r.get("/:serverId/stacks/:stackName/services", { tag: "server:read", readOnly: true }, ctrl.stackServices);
r.get("/:serverId/stacks/:stackName/tasks", { tag: "server:read", readOnly: true }, ctrl.stackTasks);
r.post("/:serverId/stacks/:stackName/observe", { tag: "server:write" }, observe.observe);
r.get("/:serverId/networks", { tag: "server:read", readOnly: true }, ctrl.networks);
r.get("/:serverId/volumes", { tag: "server:read", readOnly: true }, ctrl.volumes);
r.get("/:serverId/configs", { tag: "server:read", readOnly: true }, ctrl.configs);
r.get("/:serverId/secrets", { tag: "server:read", readOnly: true }, ctrl.secrets);

export const swarmRoutes = r.hono;
