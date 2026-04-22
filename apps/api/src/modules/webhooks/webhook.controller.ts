/**
 * Webhook controller — unified entry point for GitHub and Stripe webhooks.
 *
 * Each provider has a dedicated POST route (`/api/webhooks/:provider`).
 * The controller verifies the signature, then delegates to the registered
 * provider handler. This keeps provider-specific logic out of this file.
 */

import type { Context } from "hono";
import { getWebhookProvider } from "./webhook.service";
import type { WebhookProviderName } from "./webhook.types";

/** Allowed provider names — rejects anything else at the route level. */
const ALLOWED_PROVIDERS = new Set<string>(["github", "stripe"]);

/**
 * Generic webhook handler — looks up the provider by route param
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

  /* Read the raw body once — needed for signature verification */
  const rawBody = await c.req.text();

  /* Flatten headers into a plain object */
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  /* Step 1: Verify signature */
  const verification = provider.verify(rawBody, headers);
  if (!verification.valid) {
    return c.json({ error: verification.error ?? "Invalid signature" }, 401);
  }

  /* Step 2: Parse and handle */
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await provider.handle(payload, headers);
    // Always return 200 for verified webhooks — returning 4xx/5xx causes
    // GitHub to retry, which can trigger duplicate deployments on transient errors.
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal handler error";
    console.error(`[Webhook] ${providerName} handler error:`, err);
    return c.json({ success: false, error: message }, 200);
  }
}
