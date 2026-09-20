/** HTTP paths and envelopes over the retained backup destination service. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

export async function listAll(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.list(operationContext(c))) });
}
export async function getOne(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.get(operationContext(c), param(c, "id"))) });
}
export async function getUsage(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.usage(operationContext(c), param(c, "id"))) });
}
export async function create(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.create(operationContext(c), await c.req.json())) });
}
export async function update(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.update(operationContext(c), param(c, "id"), await c.req.json().catch(() => ({})))) });
}
export async function remove(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.remove(operationContext(c), param(c, "id"))) });
}
export async function preflight(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.preflight(operationContext(c), param(c, "id"))) });
}
export async function preflightDraft(c: Context) {
  return c.json({ data: await operationData(c, getPlatformKernel().backupDestinations.preflightDraft(operationContext(c), await c.req.json().catch(() => null))) });
}
