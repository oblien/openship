import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import type { TSaveSwarmManagedInputBody } from "./swarm-source.schema";
import { listManagedInputs, removeManagedInput, saveManagedInput } from "./swarm-managed-input.service";

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ inputs: await listManagedInputs(c.req.param("id")!, ctx.organizationId) });
}
export async function save(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TSaveSwarmManagedInputBody>();
  const input = await saveManagedInput({ projectId: c.req.param("id")!, organizationId: ctx.organizationId, userId: ctx.userId, ...body });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.managed-input.saved", resourceType: "project", resourceId: c.req.param("id")!,
    after: { inputId: input.id, kind: input.kind, logicalName: input.logicalName },
  });
  return c.json({ input }, 201);
}
export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  await removeManagedInput(c.req.param("inputId")!, ctx.organizationId);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.managed-input.removed", resourceType: "project", resourceId: c.req.param("id")!,
    after: { inputId: c.req.param("inputId")! },
  });
  return c.body(null, 204);
}
