/** HTTP paths/envelopes over the same authorized operations used by the native SDK. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import { operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";

const backups = () => getPlatformKernel().backups;
export async function listProjectPolicies(c: Context) {
  return c.json({ data: await operationData(c, backups().listPolicies(getRequestContext(c), param(c, "projectId"))) });
}
export async function createProjectPolicy(c: Context) {
  return c.json({ data: await operationData(c, backups().createPolicy(getRequestContext(c), param(c, "projectId"), await c.req.json())) });
}
export async function patchPolicy(c: Context) {
  return c.json({ data: await operationData(c, backups().updatePolicy(getRequestContext(c), param(c, "policyId"), await c.req.json())) });
}
export async function removePolicy(c: Context) {
  return c.json({ data: await operationData(c, backups().removePolicy(getRequestContext(c), param(c, "policyId"))) });
}
export async function triggerManual(c: Context) {
  return c.json({ data: await operationData(c, backups().run(getRequestContext(c), param(c, "policyId"))) });
}
export async function listRuns(c: Context) {
  const limit = c.req.query("limit");
  return c.json({ data: await operationData(c, backups().listRuns(getRequestContext(c), param(c, "projectId"), {
    ...(limit !== undefined && { limit: Number(limit) }), serviceId: c.req.query("serviceId"),
  })) });
}
export async function getOneRun(c: Context) {
  return c.json({ data: await operationData(c, backups().getRun(getRequestContext(c), param(c, "runId"))) });
}
export async function protectRun(c: Context) {
  return c.json({ data: await operationData(c, backups().protectRun(getRequestContext(c), param(c, "runId"), await c.req.json().catch(() => ({})))) });
}
export async function prepareRestore(c: Context) {
  return c.json({ data: await operationData(c, backups().prepareRestore(getRequestContext(c), param(c, "runId"), await c.req.json().catch(() => ({})))) });
}
export async function applyRestore(c: Context) {
  return c.json({ data: await operationData(c, backups().applyRestore(getRequestContext(c), param(c, "restoreId"), await c.req.json())) });
}
export async function cancelRestore(c: Context) {
  return c.json({ data: await operationData(c, backups().cancelRestore(getRequestContext(c), param(c, "restoreId"))) });
}
export async function getOneRestore(c: Context) {
  return c.json({ data: await operationData(c, backups().getRestore(getRequestContext(c), param(c, "restoreId"))) });
}
export async function streamRun(c: Context) {
  return operationEvents(c, signal => backups().openRunStream(getRequestContext(c), param(c, "runId"), { signal }));
}
export async function streamRestore(c: Context) {
  return operationEvents(c, signal => backups().openRestoreStream(getRequestContext(c), param(c, "restoreId"), { signal }));
}
