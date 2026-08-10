import type { Context, Next } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    /** Raw request bytes, read ONCE — signature verification needs exact bytes. */
    webhookRawBody: Buffer;
    /** Lower-cased flattened request headers. */
    webhookHeaders: Record<string, string>;
  }
}

/**
 * Standard "read the inbound webhook once" step, shared by every `/api/webhooks/*`
 * handler (signed providers, backup triggers, generic incoming hooks). Captures
 * the raw body as a Buffer and flattens the headers so each handler verifies /
 * dispatches from one source instead of re-reading the request. Keeping this in
 * one middleware is what lets the webhook ingress be a single unified entry.
 */
export async function webhookRawBody(c: Context, next: Next) {
  const ab = await c.req.arrayBuffer();
  c.set("webhookRawBody", Buffer.from(ab));

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  c.set("webhookHeaders", headers);

  await next();
}
