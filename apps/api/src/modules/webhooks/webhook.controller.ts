/**
 * Webhook controller - unified entry point for signed provider webhooks.
 *
 * Each provider has a dedicated POST route (`/api/webhooks/:provider`).
 * The controller verifies the signature, then delegates to the registered
 * provider handler. This keeps provider-specific logic out of this file.
 *
 * Stripe is NOT a generic provider — its
 * webhook lives at `/api/billing/webhook/stripe` (verified via the Stripe SDK
 * `constructEvent`), so it is intentionally absent from the registry.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import type { Context } from "hono";
import { getWebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.service";
/** The registered handlers are the allowlist. Unregistered names never reach verification. */
export async function handleWebhook(c: Context) {
  const name = c.req.param("provider");
  const provider = name && getWebhookProvider(name);
  if (!provider) return c.json({ error: "Not found" }, 404);

  /* Raw body + headers captured once by the shared `webhookRawBody` middleware. */
  const rawBody = c.var.webhookRawBody;
  const headers = c.var.webhookHeaders;

  /* Step 1: Verify signature */
  const verification = await provider.verify(rawBody, headers);
  if (!verification.valid) {
    return c.json({ error: verification.error ?? "Invalid signature" }, 401);
  }

  /* Step 2: Parse and handle */
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await provider.handle(payload, headers, verification);
    // A valid signature proves who sent the delivery, not that its action ran.
    // Failed dispatches must remain visible and redeliverable at the provider.
    return c.json(result, result.success ? 200 : 500);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal handler error";
    errorDiagnostics.error("api/modules/webhooks/webhook.controller", `[Webhook] ${provider.name} handler error:`, err);
    return c.json({ success: false, error: message }, 500);
  }
}
