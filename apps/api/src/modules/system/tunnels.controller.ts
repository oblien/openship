/** HTTP adaptation for the shared authorized server tunnel operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

export async function listTunnels(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().servers.listTunnels(operationContext(c), c.req.param("id")!)));
}
export async function saveTunnel(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().servers.saveTunnel(operationContext(c), c.req.param("id")!, await c.req.json())), 201);
}
export async function startTunnelHandler(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().servers.startTunnel(operationContext(c), c.req.param("id")!, { tunnelId: c.req.param("tunnelId")! })));
}
export async function stopTunnelHandler(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().servers.stopTunnel(operationContext(c), c.req.param("id")!, { tunnelId: c.req.param("tunnelId")! })));
}
export async function deleteTunnel(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().servers.removeTunnel(operationContext(c), c.req.param("id")!, { tunnelId: c.req.param("tunnelId")! })));
}
