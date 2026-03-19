/**
 * Cloud routes — mounted at /api/cloud in app.ts.
 *
 * Two route sets from the same module:
 *   cloudSaasRoutes  (CLOUD_MODE)  — POST /token
 *   cloudLocalRoutes (!CLOUD_MODE) — POST /connect, POST /disconnect, GET /status
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import { rateLimiter } from "../../middleware/rate-limiter";
import * as ctrl from "./cloud.controller";

/**
 * Bearer-token session auth — used by the /token route.
 *
 * Local/desktop instances send the stored cloud session token as
 * `Authorization: Bearer <token>`. Better Auth's getSession only reads
 * signed cookies, so we look up the session directly in the DB.
 */
async function bearerSessionAuth(c: Context, next: Next) {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = header.slice(7);

  const { db, schema, eq } = await import("@repo/db");
  const [row] = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.token, token))
    .limit(1);

  if (!row || row.expiresAt < new Date()) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const [usr] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, row.userId))
    .limit(1);

  if (!usr) return c.json({ error: "Unauthorized" }, 401);

  c.set("user", usr);
  c.set("session", row);
  return next();
}

/** SaaS routes — mints namespace tokens for local instances + desktop OAuth handoff */
export const cloudSaasRoutes = new Hono();

// Desktop OAuth handoff — localhost only, PKCE + state
cloudSaasRoutes.get("/desktop-handoff", ctrl.desktopHandoff);
// Self-hosted connect handoff — HTTPS only
cloudSaasRoutes.get("/connect-handoff", ctrl.connectHandoff);
// Code exchange — no auth (code is the credential), rate-limited
cloudSaasRoutes.use("/exchange-code", rateLimiter);
cloudSaasRoutes.post("/exchange-code", ctrl.exchangeCode);

// Token minting — accepts Bearer session token from local/desktop instances
cloudSaasRoutes.use("/token", bearerSessionAuth);
cloudSaasRoutes.post("/token", ctrl.getToken);

/** Local routes — manage connection to Openship Cloud */
export const cloudLocalRoutes = new Hono();
cloudLocalRoutes.use("*", authMiddleware);
cloudLocalRoutes.post("/disconnect", ctrl.disconnect);
cloudLocalRoutes.get("/status", ctrl.status);

/**
 * Cloud connect callback — used by self-hosted settings page.
 * After the user authenticates on Openship Cloud, they're redirected
 * here with a one-time code. We exchange it and store the cloud token.
 */
cloudLocalRoutes.get("/connect-callback", ctrl.connectCallback);
