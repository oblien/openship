/**
 * Webhook controller - unified entry point for signed provider webhooks.
 *
 * Each provider has a dedicated POST route (`/api/webhooks/:provider`).
 * The controller verifies the signature, then delegates to the registered
 * provider handler. This keeps provider-specific logic out of this file.
 *
 * Only GitHub registers here today. Stripe is NOT a generic provider — its
 * webhook lives at `/api/billing/webhook/stripe` (verified via the Stripe SDK
 * `constructEvent`), so it is intentionally absent from the allowlist below.
 */

import type { Context } from "hono";
import { getWebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.service";
import type { WebhookProviderName } from "@repo/platform/engine/modules/webhooks/webhook.types";

/** Allowed provider names - rejects anything else at the route level. */
const ALLOWED_PROVIDERS = new Set<string>(["github", "azure"]);

/**
 * Generic webhook handler - looks up the provider by route param
 * and delegates verification + handling to it.
 */
export async function handleWebhook(c: Context) {
  const providerName = c.req.param("provider");

  if (!providerName || !ALLOWED_PROVIDERS.has(providerName)) {
    return c.json({ error: "Not found" }, 404);
  }

  return dispatchProvider(c, providerName as WebhookProviderName);
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function dispatchProvider(c: Context, providerName: WebhookProviderName) {
  const provider = getWebhookProvider(providerName);

  if (!provider) {
    return c.json({ error: `Webhook provider '${providerName}' is not configured` }, 404);
  }

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
    const result = await provider.handle(payload, headers);
    // A valid signature proves who sent the delivery, not that its action ran.
    // Failed dispatches must remain visible and redeliverable at the provider.
    return c.json(result, result.success ? 200 : 500);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal handler error";
    console.error(`[Webhook] ${providerName} handler error:`, err);
    return c.json({ success: false, error: message }, 500);
  }
}
