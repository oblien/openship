/** HTTP envelopes over shared credential authorization, verification and audit. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().credentials;
export async function listProviders(c: Context) {
  return c.json({ data: await operationData(c, operations().listProviders(operationContext(c))) });
}
export async function listCredentials(c: Context) {
  return c.json({ data: await operationData(c, operations().list(operationContext(c))) });
}
export async function getCredential(c: Context) {
  return c.json({ data: await operationData(c, operations().get(operationContext(c), param(c, "id"))) });
}
export async function createCredential(c: Context) {
  return c.json({ data: await operationData(c, operations().create(operationContext(c), await c.req.json())) }, 201);
}
export async function updateCredential(c: Context) {
  return c.json({ data: await operationData(c, operations().update(operationContext(c), param(c, "id"), await c.req.json())) });
}
export async function deleteCredential(c: Context) {
  return c.json(await operationData(c, operations().remove(operationContext(c), param(c, "id"))));
}
export async function verifyCredential(c: Context) {
  return c.json({ data: await operationData(c, operations().verify(operationContext(c), param(c, "id"))) });
}
