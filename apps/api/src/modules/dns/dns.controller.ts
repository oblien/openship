/** HTTP envelopes over the shared DNS credential operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().dns;
export async function listProviders(c: Context) {
  return c.json({ data: await operationData(c, operations().listProviders(operationContext(c))) });
}
export async function listCredentials(c: Context) {
  return c.json({ data: await operationData(c, operations().listCredentials(operationContext(c))) });
}
export async function getCredential(c: Context) {
  return c.json({ data: await operationData(c, operations().getCredential(operationContext(c), param(c, "id"))) });
}
export async function addCredential(c: Context) {
  return c.json({ data: await operationData(c, operations().addCredential(operationContext(c), await c.req.json())) }, 201);
}
export async function removeCredential(c: Context) {
  return c.json(await operationData(c, operations().removeCredential(operationContext(c), param(c, "id"))));
}
export async function verifyZone(c: Context) {
  return c.json(await operationData(c, operations().verifyZone(operationContext(c), await c.req.json())));
}
