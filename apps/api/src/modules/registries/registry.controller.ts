import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import type { TCreateContainerRegistryBody, TUpdateContainerRegistryBody } from "./registry.schema";
import { containerRegistryService } from "./registry.service";

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ registries: await containerRegistryService.list(ctx.organizationId) });
}

export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const registry = await containerRegistryService.create(ctx.organizationId, await c.req.json<TCreateContainerRegistryBody>());
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), { eventType: "registry.created", resourceType: "settings", resourceId: registry.id, after: registry });
  return c.json({ registry }, 201);
}

export async function update(c: Context) {
  const ctx = getRequestContext(c);
  const registry = await containerRegistryService.update(c.req.param("id")!, ctx.organizationId, await c.req.json<TUpdateContainerRegistryBody>());
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), { eventType: "registry.updated", resourceType: "settings", resourceId: registry.id, after: registry });
  return c.json({ registry });
}

export async function test(c: Context) {
  const ctx = getRequestContext(c);
  const result = await containerRegistryService.test(c.req.param("id")!, ctx.organizationId);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), { eventType: "registry.tested", resourceType: "settings", resourceId: result.registry.id, after: { id: result.registry.id, ok: true } });
  return c.json(result);
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  await containerRegistryService.remove(c.req.param("id")!, ctx.organizationId);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), { eventType: "registry.deleted", resourceType: "settings", resourceId: c.req.param("id")! });
  return c.body(null, 204);
}
