/**
 * Inbound backup webhooks.
 *
 * Separate route file because there's NO auth middleware - the bearer
 * token is the credential. Rate-limited via the existing rateLimiter
 * middleware so a leaked token can't be used as a "trigger a backup
 * every 5ms" amplification.
 *
 * POST /api/webhooks/backup - token in `Authorization: Bearer <token>`
 * header. Tokens never appear in access logs, referrer chains, proxy
 * logs, or shell history.
 *
 * Mounted at `/api/webhooks/backup` from app.ts.
 */

import { Hono, type Context } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { triggerBackupViaWebhook } from "./triggers/webhook";

const r = secureRouter(new Hono(), {
  module: "backups-webhook",
  basePath: "/api/webhooks/backup",
});
// No explicit limiter here: secureRouter injects one per route (fixes #123).
// These are `r.public` token-auth routes → default-anon (per IP), matching the
// old global-limiter behaviour without double-charging.

function extractClientContext(c: Context): {
  clientIp: string | undefined;
  userAgent: string | undefined;
} {
  const clientIp = c.var.clientIp ?? undefined;
  const userAgent = c.req.header("user-agent") ?? undefined;
  return { clientIp, userAgent };
}

/** Preferred shape: token in the Authorization header. */
r.public(
  "post",
  "/",
  { reason: "Backup webhook - bearer token in Authorization header is the credential" },
  async (c) => {
    const authHeader = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) {
      return c.json({ error: "Not found" }, 404);
    }
    const token = match[1]?.trim();
    if (!token) return c.json({ error: "Not found" }, 404);

    const { clientIp, userAgent } = extractClientContext(c);
    const result = await triggerBackupViaWebhook({ token, clientIp, userAgent });

    if ("error" in result) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ data: { runId: result.runId } });
  },
);

export const backupWebhookRoutes = r.hono;

