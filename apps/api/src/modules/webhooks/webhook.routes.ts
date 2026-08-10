/**
 * Unified webhook ingress — the SINGLE entry for every inbound `/api/webhooks/*`
 * call. One router, one shared raw-body middleware (`webhookRawBody`), three
 * handlers, no duplicated body/header reading:
 *
 *   POST /api/webhooks/:provider        signed provider (GitHub) — HMAC verified
 *   POST /api/webhooks/backup           backup trigger — bearer token is the credential
 *   POST /api/webhooks/incoming/:id     generic per-project hook — token / HMAC / none
 *
 * (Stripe is NOT here — it has its own SDK-verified route at
 * /api/billing/webhook/stripe.) None require session auth; each handler verifies
 * its own credential. Static segments (`backup`, `incoming/…`) resolve before the
 * `:provider` param (Hono is static-first).
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureRouter } from "../../lib/secure-router";
import { handleWebhook } from "./webhook.controller";
import { webhookRawBody } from "./webhook.middleware";
import { triggerHook as triggerIncomingHook } from "../incoming-webhooks/incoming.controller";
import { triggerBackupViaWebhook } from "../backups/triggers/webhook";

const r = secureRouter(new Hono(), {
  module: "webhooks",
  basePath: "/api/webhooks",
});

/** 5 MB - well above typical webhook payloads (~200 KB). */
const MAX_WEBHOOK_BODY = 5 * 1024 * 1024;
const bodyCap = bodyLimit({ maxSize: MAX_WEBHOOK_BODY });

const PUBLIC = { rateLimit: "webhook-ingress" as const };

/** Generic per-project incoming hook — token / HMAC / none, dispatches an action. */
r.public(
  "post",
  "/incoming/:id",
  { ...PUBLIC, reason: "Incoming webhook - per-hook token/HMAC/none credential verified in handler" },
  bodyCap,
  webhookRawBody,
  triggerIncomingHook,
);

/** Backup trigger — bearer token in the Authorization header is the credential. */
r.public(
  "post",
  "/backup",
  { ...PUBLIC, reason: "Backup webhook - bearer token in Authorization header is the credential" },
  bodyCap,
  webhookRawBody,
  async (c: Context) => {
    const authHeader = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    const token = match?.[1]?.trim();
    if (!token) return c.json({ error: "Not found" }, 404);

    const result = await triggerBackupViaWebhook({
      token,
      clientIp: c.var.clientIp ?? undefined,
      userAgent: c.req.header("user-agent") ?? undefined,
    });
    if ("error" in result) return c.json({ error: "Not found" }, 404);
    return c.json({ data: { runId: result.runId } });
  },
);

/** Signed provider webhooks (GitHub) — HMAC/signature verified in the handler. */
r.public(
  "post",
  "/:provider",
  { ...PUBLIC, reason: "Provider webhook (GitHub) - HMAC/signature verified in handler" },
  bodyCap,
  webhookRawBody,
  handleWebhook,
);

export const webhookRoutes = r.hono;
