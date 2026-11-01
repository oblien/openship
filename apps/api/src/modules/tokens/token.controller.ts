/** HTTP paths and envelopes over shared user credential operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";
const tokens = () => getPlatformKernel().tokens;

export async function list(c: Context) {
  return c.json({ data: await operationData(c, tokens().list(operationContext(c))) });
}
export async function create(c: Context) {
  return c.json({ data: await operationData(c, tokens().create(operationContext(c), await c.req.json())) }, 201);
}
export async function revoke(c: Context) {
  return c.json({ data: await operationData(c, tokens().revoke(operationContext(c), param(c, "id"))) });
}
export async function authorizeMcpClient(c: Context) {
  return c.json({ data: await operationData(c, tokens().authorizeMcpClient(operationContext(c), await c.req.json())) });
}
export async function listMcpClients(c: Context) {
  return c.json({ data: await operationData(c, tokens().listMcpClients(operationContext(c))) });
}
export async function getMcpClient(c: Context) {
  return c.json({ data: await operationData(c, tokens().getMcpClient(operationContext(c), param(c, "clientId"))) });
}
export async function disconnectMcpClient(c: Context) {
  return c.json({ data: await operationData(c, tokens().disconnectMcpClient(operationContext(c), param(c, "clientId"))) });
}
