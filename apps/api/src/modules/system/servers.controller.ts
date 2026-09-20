/** HTTP status/envelope adapters over the shared server operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().servers;
export async function listServers(c: Context) {
  return c.json(await operationData(c, operations().list(operationContext(c))));
}
export async function getServer(c: Context) {
  return c.json(await operationData(c, operations().get(operationContext(c), param(c, "id"))));
}
export async function getInfrastructure(c: Context) {
  return c.json(await operationData(c, operations().infrastructure(operationContext(c), param(c, "id"))));
}
export async function probeReachability(c: Context) {
  return c.json(await operationData(c, operations().reachability(operationContext(c), param(c, "id"))));
}
export async function createServer(c: Context) {
  return c.json(await operationData(c, operations().create(operationContext(c), await c.req.json())), 201);
}
export async function updateServer(c: Context) {
  return c.json(await operationData(c, operations().update(operationContext(c), param(c, "id"), await c.req.json())));
}
export async function serverDeletionPreview(c: Context) {
  return c.json(await operationData(c, operations().deletionPreview(operationContext(c), param(c, "id"))));
}
export async function deleteServer(c: Context) {
  const result = await operationData(c, operations().remove(operationContext(c), param(c, "id"), {
    destroyOnSource: c.req.query("destroyOnSource") === "true",
  }));
  return c.json(result, result.ok ? 200 : 409);
}
export async function execOnServer(c: Context) {
  return c.json({ data: await operationData(c, operations().exec(operationContext(c), param(c, "id"), await c.req.json())) });
}
