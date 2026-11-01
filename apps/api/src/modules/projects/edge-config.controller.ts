import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, applyOperationContext } from "../../lib/operation-context";

export async function getEdgeConfig(c: Context) {
  const result = await getPlatformKernel().projects.getEdgeConfig(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

