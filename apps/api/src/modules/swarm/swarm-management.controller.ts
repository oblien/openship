import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import type { TClaimSwarmStackBody, TReleaseSwarmManagementBody } from "./swarm-source.schema";
import { swarmManagement } from "./swarm-management.service";

export async function claim(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TClaimSwarmStackBody>();
  const result = await swarmManagement.claim({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    confirmedStackName: body.confirmedStackName,
    previewLiveDigest: body.previewLiveDigest,
    expectedSourceVersion: body.expectedSourceVersion,
  });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.claim.requested",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: result,
  });
  return c.json(result);
}

export async function release(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TReleaseSwarmManagementBody>();
  const result = await swarmManagement.release(c.req.param("id")!, ctx.organizationId, body.confirmedStackName, body.expectedSourceVersion);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.management.released",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: result,
  });
  return c.json(result);
}
