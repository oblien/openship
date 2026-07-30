import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import type { TRebindSwarmManagerBody } from "./swarm-source.schema";
import { swarmConnection } from "./swarm-connection.service";

export async function status(c: Context) {
  const ctx = getRequestContext(c);
  return c.json(await swarmConnection.status(c.req.param("id")!, ctx.organizationId));
}

export async function rebind(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TRebindSwarmManagerBody>();
  const result = await swarmConnection.rebind({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    serverId: body.serverId,
  });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.manager.rebound",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: { managerServerId: result.managerServerId, clusterId: result.clusterId, endpoint: result.endpoint },
  });
  return c.json(result);
}
