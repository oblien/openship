/** HTTP envelopes over shared notification operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";
const notifications = () => getPlatformKernel().notifications;
export async function listCategories(c: Context) { return c.json(await operationData(c, notifications().categories(operationContext(c)))); }
export async function listChannels(c: Context) { return c.json({ channels: await operationData(c, notifications().listChannels(operationContext(c))) }); }
export async function createChannel(c: Context) { return c.json(await operationData(c, notifications().createChannel(operationContext(c), await c.req.json()))); }
export async function updateChannel(c: Context) { return c.json(await operationData(c, notifications().updateChannel(operationContext(c), param(c, "id"), await c.req.json()))); }
export async function deleteChannel(c: Context) { return c.json(await operationData(c, notifications().removeChannel(operationContext(c), param(c, "id")))); }
export async function listSubscriptions(c: Context) { return c.json({ subscriptions: await operationData(c, notifications().listSubscriptions(operationContext(c))) }); }
export async function upsertSubscription(c: Context) { return c.json({ subscription: await operationData(c, notifications().upsertSubscription(operationContext(c), await c.req.json())) }); }
export async function deleteSubscription(c: Context) { return c.json(await operationData(c, notifications().removeSubscription(operationContext(c), param(c, "id")))); }
export async function listDefaults(c: Context) { return c.json({ defaults: await operationData(c, notifications().listDefaults(operationContext(c))) }); }
export async function upsertDefault(c: Context) { return c.json({ default: await operationData(c, notifications().upsertDefault(operationContext(c), await c.req.json())) }); }
export async function unseenCount(c: Context) { return c.json({ count: await operationData(c, notifications().unseenCount(operationContext(c))) }); }
export async function markSeen(c: Context) { return c.json(await operationData(c, notifications().markSeen(operationContext(c), param(c, "id")))); }
export async function testChannel(c: Context) {
  const result = await operationData(c, notifications().testChannel(operationContext(c), param(c, "id")));
  return c.json(result, result.ok ? 200 : 400);
}
export async function listDeliveries(c: Context) {
  const input = { unseen: c.req.query("unseen") === "true", limit: Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500) };
  return c.json({ deliveries: await operationData(c, notifications().listDeliveries(operationContext(c), input)) });
}
