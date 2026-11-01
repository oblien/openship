import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, applyOperationContext } from "../../lib/operation-context";

export async function candidates(c: Context) {
  const result = await getPlatformKernel().projects.listConnectionCandidates(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function list(c: Context) {
  const result = await getPlatformKernel().projects.listConnections(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function consumers(c: Context) {
  const result = await getPlatformKernel().projects.listConnectionConsumers(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function create(c: Context) {
  const result = await getPlatformKernel().projects.createConnection(operationContext(c), param(c, "id"), await c.req.json());
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function createBundle(c: Context) {
  const result = await getPlatformKernel().projects.connectBundle(operationContext(c), param(c, "id"), await c.req.json());
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function remove(c: Context) {
  const result = await getPlatformKernel().projects.removeConnection(operationContext(c), param(c, "id"), param(c, "linkId"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}
