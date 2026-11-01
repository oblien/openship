/** HTTP adapters over instance-authorized edge orphan operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

export async function listUntrackedEdgeSites(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().system.listUntrackedEdgeSites(operationContext(c))) });
}
export async function removeUntrackedEdgeSite(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().system.removeUntrackedEdgeSite(operationContext(c), await c.req.json())) });
}
