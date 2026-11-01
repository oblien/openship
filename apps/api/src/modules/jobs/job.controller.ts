/** HTTP paths and envelopes over the same authorized operations used by the SDK. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";

const jobs = () => getPlatformKernel().jobs;

export async function list(c: Context) {
  return c.json({ data: await operationData(c, jobs().list(operationContext(c))) });
}
export async function get(c: Context) {
  return c.json({ data: await operationData(c, jobs().get(operationContext(c), param(c, "key"))) });
}
export async function listRuns(c: Context) {
  const limit = c.req.query("limit");
  return c.json({ data: await operationData(c, jobs().listRuns(operationContext(c), param(c, "key"), limit === undefined ? {} : { limit: Number(limit) })) });
}
export async function triggerEvents(c: Context) {
  return c.json({ data: await operationData(c, jobs().triggerEvents(operationContext(c))) });
}
export async function backupSchedules(c: Context) {
  return c.json({ data: await operationData(c, jobs().backupSchedules(operationContext(c))) });
}
export async function create(c: Context) {
  return c.json({ data: await operationData(c, jobs().create(operationContext(c), await c.req.json())) }, 201);
}
export async function update(c: Context) {
  return c.json({ data: await operationData(c, jobs().update(operationContext(c), param(c, "key"), await c.req.json())) });
}
export async function remove(c: Context) {
  return c.json(await operationData(c, jobs().remove(operationContext(c), param(c, "key"))));
}
export async function run(c: Context) {
  return c.json({ data: await operationData(c, jobs().run(operationContext(c), param(c, "key"))) });
}
export async function getRun(c: Context) {
  return c.json({ data: await operationData(c, jobs().getRun(operationContext(c), param(c, "runId"))) });
}
export async function streamRun(c: Context) {
  return operationEvents(c, signal => jobs().openRunStream(operationContext(c), param(c, "runId"), { signal }));
}
