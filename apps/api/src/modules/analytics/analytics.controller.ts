/** HTTP envelopes over shared analytics operations and owned usage streams. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";
import { param } from "../../lib/controller-helpers";

const analytics = () => getPlatformKernel().analytics;
const projectId = (c: Context) => c.req.query("projectId") ?? "";
const range = (c: Context) => ({ from: c.req.query("from"), to: c.req.query("to"), domain: c.req.query("domain") });

export async function summary(c: Context) {
  return c.json({ data: await operationData(c, analytics().summary(operationContext(c), projectId(c), { domain: c.req.query("domain") })) });
}
export async function periods(c: Context) {
  return c.json({ data: await operationData(c, analytics().periods(operationContext(c), projectId(c), range(c))) });
}
export async function overview(c: Context) {
  return c.json({ data: await operationData(c, analytics().overview(operationContext(c), projectId(c), range(c))) });
}
export async function projectGeo(c: Context) {
  return c.json({ data: await operationData(c, analytics().geo(operationContext(c), projectId(c), range(c))) });
}
export async function deploymentStats(c: Context) {
  return c.json({ data: await operationData(c, analytics().deploymentStats(operationContext(c), projectId(c))) });
}
export async function usage(c: Context) {
  return c.json({ data: await operationData(c, analytics().usage(operationContext(c), projectId(c))) });
}
export async function containerInfo(c: Context) {
  return c.json({ data: await operationData(c, analytics().containerInfo(operationContext(c), projectId(c))) });
}
export async function resources(c: Context) {
  return c.json({ data: await operationData(c, analytics().resources(operationContext(c), projectId(c))) });
}
export async function setPathsCollection(c: Context) {
  return c.json({ data: await operationData(c, analytics().setPathsCollection(operationContext(c), param(c, "projectId"), await c.req.json())) });
}
export async function usageHistory(c: Context) {
  return c.json({ data: await operationData(c, analytics().usageHistory(operationContext(c), projectId(c), { from: c.req.query("from"), to: c.req.query("to"), serviceKey: c.req.query("serviceKey") })) });
}
export async function usageStream(c: Context) {
  return operationEvents(c, signal => analytics().openUsageStream(operationContext(c), projectId(c), { signal }));
}
export async function dashboard(c: Context) {
  return c.json({ data: await operationData(c, analytics().dashboard(operationContext(c))) });
}
export async function serverAnalytics(c: Context) {
  return c.json({ data: await operationData(c, analytics().serverBuckets(operationContext(c), param(c, "serverId"), { domain: c.req.query("domain") ?? "", from: c.req.query("from"), to: c.req.query("to") })) });
}
export async function serverGeo(c: Context) {
  return c.json({ data: await operationData(c, analytics().serverGeo(operationContext(c), param(c, "serverId"), { domain: c.req.query("domain") ?? "", day: c.req.query("day") })) });
}
export async function serverAnalyticsLive(c: Context) {
  return c.json({ data: await operationData(c, analytics().serverLive(operationContext(c), param(c, "serverId"), { domain: c.req.query("domain") ?? "" })) });
}
