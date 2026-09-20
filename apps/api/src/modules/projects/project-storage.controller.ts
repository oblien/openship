import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, applyOperationContext } from "../../lib/operation-context";

export async function get(c: Context) {
  const result = await getPlatformKernel().projects.getStorage(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function bind(c: Context) {
  const result = await getPlatformKernel().projects.bindStorage(operationContext(c), param(c, "id"), await c.req.json());
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function unbind(c: Context) {
  const result = await getPlatformKernel().projects.unbindStorage(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

