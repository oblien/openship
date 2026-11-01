/** HTTP envelopes for the shared owner-authorized Git source operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
const ops = () => getPlatformKernel().github;
export async function listSources(c: Context) {
  const data = await operationData(c, ops().listSources(operationContext(c)));
  return c.json(data, 200);
}
export async function beginManifest(c: Context) {
  const data = await operationData(c, ops().beginManifest(operationContext(c), await c.req.json()));
  return c.json(data, 201);
}
export async function convertManifest(c: Context) {
  const data = await operationData(c, ops().convertManifest(operationContext(c), await c.req.json()));
  return c.json(data, 201);
}
export async function createManual(c: Context) {
  const data = await operationData(c, ops().createManualSource(operationContext(c), await c.req.json()));
  return c.json(data, 201);
}
export async function updateSource(c: Context) {
  const data = await operationData(c, ops().updateSource(operationContext(c), c.req.param("id")!, await c.req.json()));
  return c.json({ data }, 200);
}
export async function verifySource(c: Context) {
  const data = await operationData(c, ops().verifySource(operationContext(c), c.req.param("id")!));
  return c.json({ data }, 200);
}
export async function setDefaultSource(c: Context) {
  const data = await operationData(c, ops().setDefaultSource(operationContext(c), c.req.param("id")!));
  return c.json({ data }, 200);
}
export async function createInstallUrl(c: Context) {
  const data = await operationData(c, ops().createInstallUrl(operationContext(c), c.req.param("id")!));
  return c.json(data, 201);
}
export async function deleteSource(c: Context) {
  const data = await operationData(c, ops().deleteSource(operationContext(c), c.req.param("id")!));
  return c.json(data, 200);
}
