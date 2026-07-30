import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import type { TRenderSwarmStackSourceBody, TSetSwarmStackRegistryBody, TUpdateSwarmStackSourceBody } from "./swarm-source.schema";
import * as source from "./swarm-source.service";

export async function get(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ source: await source.getStackSource(c.req.param("id")!, ctx.organizationId) });
}

export async function handoff(c: Context) {
  const ctx = getRequestContext(c);
  const result = await source.exportStackHandoff(c.req.param("id")!, ctx.organizationId);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.handoff.exported",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    // Never add exported YAML, override content, or secret references to audit.
    after: { stackName: result.stackName, managementMode: result.managementMode, revision: result.revision?.id ?? null },
  });
  return c.json(result);
}

export async function validate(c: Context) {
  const ctx = getRequestContext(c);
  // secureRouter already ran the TypeBox body validator; Context is kept
  // unparameterized here to match the repository's controller convention.
  const body = await c.req.json<TUpdateSwarmStackSourceBody>();
  return c.json(await source.validateSource(c.req.param("id")!, ctx.organizationId, body));
}

export async function replace(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TUpdateSwarmStackSourceBody>();
  const result = await source.replaceStackSource(c.req.param("id")!, ctx.organizationId, body);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.source.replaced",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: {
      kind: result.kind,
      composePaths: result.composePaths,
      branch: result.branch,
      commitSha: result.commitSha,
      version: result.version,
      digest: result.digest,
    },
  });
  return c.json({ source: result });
}

export async function setRegistry(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TSetSwarmStackRegistryBody>();
  const result = await source.setStackRegistry(c.req.param("id")!, ctx.organizationId, body.registryId);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.registry.set",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: { registryId: result.registryId },
  });
  return c.json({ source: result });
}

export async function render(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TRenderSwarmStackSourceBody>();
  return c.json(await source.renderStackSource(c.req.param("id")!, ctx.organizationId, body.environment ?? {}, ctx));
}
