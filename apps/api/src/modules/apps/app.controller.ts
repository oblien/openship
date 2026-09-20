/** HTTP paths and envelopes over shared catalog, installer, and project operations. */
import type { Context } from "hono";
import type { InstallAppInput } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

export async function catalog(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().apps.listCatalog(operationContext(c))) });
}
export async function catalogEntry(c: Context) {
  const result = await operationData(c, getPlatformKernel().apps.getCatalogEntry(operationContext(c), param(c, "id")));
  return c.json({ data: result.template, draft: result.draft });
}
export async function hostFit(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().apps.hostFit(operationContext(c), param(c, "id"), {
    deployTarget: c.req.query("deployTarget") || undefined, serverId: c.req.query("serverId") || undefined,
  })) });
}
export async function addCustom(c: Context) {
  const body = await c.req.json().catch(() => null);
  if (body == null || typeof body !== "object") return c.json({ error: "Upload a JSON app definition." }, 400);
  return c.json({ data: await operationData(c, getPlatformKernel().apps.saveCustom(operationContext(c), body)) });
}
export async function listCustom(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().apps.listCustom(operationContext(c))) });
}
export async function removeCustom(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().apps.removeCustom(operationContext(c), param(c, "appId"))) });
}
export async function install(c: Context) {
  const body = await c.req.json<InstallAppInput>().catch(() => null);
  if (!body?.templateId) return c.json({ error: "templateId is required" }, 400);
  return c.json({ data: await operationData(c, getPlatformKernel().apps.install(operationContext(c), body)) });
}
export async function getSettings(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().projects.getAppSettings(operationContext(c), param(c, "id"))) });
}
export async function patchSettings(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ data: await operationData(c, getPlatformKernel().projects.updateAppSettings(operationContext(c), param(c, "id"), body)) });
}
export async function getConnection(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().projects.getAppConnection(operationContext(c), param(c, "id"))) });
}
