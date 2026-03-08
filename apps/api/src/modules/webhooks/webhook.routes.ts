/**
 * Webhook routes — unified entry point for GitHub and Stripe.
 *
 * POST /api/webhooks/:provider — dispatches to the registered provider
 *
 * Only "github" and "stripe" are accepted. All other paths return 404.
 * These routes do NOT require session auth — they verify signatures instead.
 */

import { Hono } from "hono";
import { handleWebhook } from "./webhook.controller";

export const webhookRoutes = new Hono();

webhookRoutes.post("/:provider", handleWebhook);
