/** HTTP adapters over shared live OpenResty rate-limit operations. */
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
