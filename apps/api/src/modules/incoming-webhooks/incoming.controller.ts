/** HTTP adapters over the shared incoming-webhook operations; ingress owns headers/raw bytes. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { triggerIncomingWebhook } from "@repo/platform/engine/modules/incoming-webhooks/incoming.service";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";
const hooks = () => getPlatformKernel().webhooks;

function extractBearer(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m?.[1]) return m[1].trim();
  return null;
}

export async function triggerHook(c: Context) {
  const id = param(c, "id");
  const bearer = extractBearer(c);
  const signature =
    c.req.header("x-hub-signature-256") ??
    c.req.header("x-signature-256") ??
    c.req.header("x-signature") ??
    null;

  const result = await triggerIncomingWebhook({
    id,
    bearer,
    signature,
    rawBody: c.var.webhookRawBody,
    clientIp: c.var.clientIp ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });

  if ("error" in result) {
    // Auth / existence failures are opaque (404) so a caller can't probe for
    // valid hook ids or token prefixes. A genuine action failure is a 502.
    if (result.error === "action_failed") {
      return c.json({ error: "Action failed" }, 502);
    }
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ data: { action: result.action, ref: result.ref } });
}


function pageOpts(c: Context) {
  const limit = c.req.query("limit");
  return { cursor: c.req.query("cursor") || undefined, ...(limit === undefined ? {} : { limit: Number(limit) }) };
}
export async function list(c: Context) {
  return c.json({ data: await operationData(c, hooks().list(operationContext(c), param(c, "id"))) });
}
export async function create(c: Context) {
  return c.json({ data: await operationData(c, hooks().create(operationContext(c), param(c, "id"), await c.req.json())) }, 201);
}
export async function update(c: Context) {
  return c.json({ data: await operationData(c, hooks().update(operationContext(c), param(c, "id"), param(c, "hookId"), await c.req.json())) });
}
export async function rotate(c: Context) {
  return c.json({ data: await operationData(c, hooks().rotate(operationContext(c), param(c, "id"), param(c, "hookId"))) });
}
export async function remove(c: Context) {
  return c.json({ data: await operationData(c, hooks().remove(operationContext(c), param(c, "id"), param(c, "hookId"))) });
}
export async function invoke(c: Context) {
  return c.json({ data: await operationData(c, hooks().invoke(operationContext(c), param(c, "id"), param(c, "hookId"))) });
}
export async function deliveries(c: Context) {
  return c.json({ data: await operationData(c, hooks().deliveries(operationContext(c), param(c, "id"), pageOpts(c))) });
}
export async function hookDeliveries(c: Context) {
  return c.json({ data: await operationData(c, hooks().hookDeliveries(operationContext(c), param(c, "id"), param(c, "hookId"), pageOpts(c))) });
}
export async function orgDeliveries(c: Context) {
  return c.json({ data: await operationData(c, hooks().listDeliveries(operationContext(c), pageOpts(c))) });
}
