import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import { swarmObserve } from "./swarm-observe.service";

export async function observe(c: Context) {
  const ctx = getRequestContext(c);
  const result = await swarmObserve.observe({
    serverId: c.req.param("serverId")!,
    organizationId: ctx.organizationId,
    stackName: c.req.param("stackName")!,
  });
  if (result.created) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "swarm.stack.observe",
      resourceType: "project",
      resourceId: result.projectId,
      after: { stackId: result.stackId, observedDigest: result.observedDigest },
    });
  }
  return c.json(result, result.created ? 201 : 200);
}
