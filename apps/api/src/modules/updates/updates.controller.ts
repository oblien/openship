/** HTTP adapters over shared update discovery and deployment operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";
export async function listUpdates(c: Context) {
  const behindOnly = ["1", "true"].includes((c.req.query("behind") ?? "").toLowerCase());
  return c.json({ data: await operationData(c, getPlatformKernel().updates.list(operationContext(c), { behindOnly })) });
}
export async function triggerScan(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().updates.scan(operationContext(c))) });
}
export async function applyUpdate(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().updates.apply(operationContext(c), param(c, "projectId"))) });
}
