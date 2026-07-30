import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import type { TCreateSwarmStackBindingBody } from "./swarm-source.schema";
import { swarmStackBinding } from "./swarm-stack.service";

export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TCreateSwarmStackBindingBody>();
  const result = await swarmStackBinding.create({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    serverId: body.serverId,
    stackName: body.stackName,
  });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.bound",
    resourceType: "project",
    resourceId: result.projectId,
    after: { stackName: result.stackName, managerServerId: result.managerServerId, clusterId: result.clusterId },
  });
  return c.json(result, 201);
}
