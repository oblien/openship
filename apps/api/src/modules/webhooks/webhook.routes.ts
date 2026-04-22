/**
 * Webhook routes — unified entry point for GitHub and Stripe.
 *
 * POST /api/webhooks/:provider — dispatches to the registered provider
 *
 * Only "github" and "stripe" are accepted. All other paths return 404.
 * These routes do NOT require session auth — they verify signatures instead.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { handleWebhook } from "./webhook.controller";

export const webhookRoutes = new Hono();

/** 5 MB — well above typical GitHub payloads (~200 KB). */
const MAX_WEBHOOK_BODY = 5 * 1024 * 1024;

/**
 * Simple per-IP rate limiter for webhook endpoints.
 * 120 requests per minute per IP — enough for burst pushes, blocks floods.
 */
const webhookIpCounts = new Map<string, { count: number; resetAt: number }>();

webhookRoutes.use("*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
  const now = Date.now();
  const window = 60_000;
  const max = 120;
  const entry = webhookIpCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    webhookIpCounts.set(ip, { count: 1, resetAt: now + window });
  } else if (entry.count >= max) {
    return c.json({ error: "Too many requests" }, 429);
  } else {
    entry.count++;
  }
  await next();
});

webhookRoutes.post(
  "/:provider",
  bodyLimit({ maxSize: MAX_WEBHOOK_BODY }),
  handleWebhook,
);
