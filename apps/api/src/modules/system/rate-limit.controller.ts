/** HTTP adapters over shared live OpenResty settings: rate limits and visitor pages. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().servers;
export async function getRateLimit(c: Context) {
  return c.json(await operationData(c, operations().getRateLimit(operationContext(c), param(c, "id"))));
}
export async function updateRateLimit(c: Context) {
  return c.json(await operationData(c, operations().updateRateLimit(operationContext(c), param(c, "id"), await c.req.json())));
}

export async function getEdgePages(c: Context) {
  return c.json(await operationData(c, operations().getEdgePages(operationContext(c), param(c, "id"))));
}
export async function updateEdgePages(c: Context) {
  return c.json(await operationData(c, operations().updateEdgePages(operationContext(c), param(c, "id"), await c.req.json())));
}
