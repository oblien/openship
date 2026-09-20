import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { handleOblienWebhook } from "@repo/platform/engine/modules/billing/oblien-webhook.service";

/** Preserve raw signed bytes; no session or fabricated native principal. */
export async function oblienWebhook(c: Context) {
  const result = await handleOblienWebhook(await c.req.text(), c.req.header("x-webhook-signature"), c.req.header("x-webhook-id"));
  return c.json(result.payload, result.status as ContentfulStatusCode);
}
