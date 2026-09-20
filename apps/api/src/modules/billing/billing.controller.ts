/** HTTP codecs over the shared billing operations. Provider signatures stay at ingress. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { publicBillingOperations } from "@repo/platform/engine/modules/billing/billing.operations";
import { operationContext, operationData } from "../../lib/operation-context";

export async function listPlans(c: Context) {
  const data = await publicBillingOperations.listPlans({ locale: c.req.query("locale") ?? c.req.header("accept-language") });
  c.header("Cache-Control", "public, max-age=60, s-maxage=60");
  c.header("Vary", "Accept-Language");
  return c.json({ data });
}
export async function getState(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.getState(operationContext(c))) }); }
export async function getResources(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.getResources(operationContext(c))) }); }
export async function getSubscription(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.getSubscription(operationContext(c))) }); }
export async function createSubscription(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.createSubscription(operationContext(c), await c.req.json())) }, 201); }
export async function cancelSubscription(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.cancelSubscription(operationContext(c))) }); }
export async function resumeSubscription(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.resumeSubscription(operationContext(c))) }); }
export async function createTopup(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.createTopup(operationContext(c), await c.req.json())) }, 201); }
export async function listTopupPacks(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.listTopupPacks(operationContext(c))) }); }
export async function createPortal(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.createPortal(operationContext(c))) }); }
export async function getUsage(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.getUsage(operationContext(c), { from: c.req.query("from"), to: c.req.query("to"), groupBy: c.req.query("groupBy") as "hour" | "day" | undefined })) }); }
export async function listAllowanceDetail(c: Context) { return c.json({ data: await operationData(c, getPlatformKernel().billing.listAllowanceDetail(operationContext(c))) }); }

export async function stripeWebhook(c: Context) {
  return c.json({ error: "Billing is managed by Oblien; direct Stripe webhooks are retired" }, 410);
}
