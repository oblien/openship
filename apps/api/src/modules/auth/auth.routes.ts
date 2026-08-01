/**
 * Auth API — mounted at /api/auth in app.ts.
 *
 * Two surfaces:
 *   1. **Desktop-mode endpoints** (gated by env.DEPLOY_MODE === "desktop")
 *      — bootstrap zero-auth session + cloud OAuth handoff.
 *   2. **Better Auth catch-all** — every standard endpoint
 *      (sign-in/up, organization plugin, OAuth callbacks, etc.) is
 *      delegated to Better Auth's handler.
 *
 * Handlers live in auth.controller.ts; this file is route wiring only.
 */

import { Hono } from "hono";
import { db, eq, schema } from "@repo/db";
import { env } from "../../config/env";
import { auth, isSaasDeployment } from "../../lib/auth";
import { normalizeMcpRedirectUri } from "../../lib/oauth-redirect";
import { internalAuth } from "../../middleware/internal-auth";
import { isLoopbackRequest } from "../../middleware/loopback-peer";
import * as ctrl from "./auth.controller";

export const authRoutes = new Hono();

if (env.DEPLOY_MODE === "desktop") {
  authRoutes.get("/get-session", ctrl.getSession);
  authRoutes.get("/desktop-login", ctrl.desktopLogin);
  authRoutes.get("/cloud-callback", ctrl.cloudCallback);
  authRoutes.post("/desktop-auth-start", internalAuth, ctrl.desktopAuthStart);
  authRoutes.get("/desktop-auth-poll", ctrl.desktopAuthPoll);
  authRoutes.get("/desktop-claim", ctrl.desktopClaim);
}

// Invite-only sign-up guard (runs BEFORE the Better Auth catch-all). SaaS keeps
// open public signup. On self-host the ONLY Better Auth signup allowed is the
// FIRST account and only from loopback (CLI bootstrap / local dev) — this closes
// the remote first-admin race and public invite-hijack signup. Every other new
// account is created via the token-bound POST /api/system/invite-signup, so a
// remote peer can never create an account through /sign-up here.
authRoutes.on("POST", "/sign-up/*", async (c, next) => {
  if (isSaasDeployment) return next();
  const [anyUser] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  if (!anyUser && isLoopbackRequest(c)) return next();
  return c.json(
    {
      error: "Public sign-up is disabled on this instance. Use your invitation link to join.",
      code: "SIGNUP_DISABLED",
    },
    403,
  );
});

// Better Auth catch-all — must be last so the desktop overrides + signup guard win.
authRoutes.on(["GET", "POST"], "/*", async (c) => {
  const request = await normalizeMcpRedirectUri(c.req.raw, async (clientId) => {
    const [client] = await db
      .select({ redirectUrls: schema.oauthApplication.redirectUrls })
      .from(schema.oauthApplication)
      .where(eq(schema.oauthApplication.clientId, clientId))
      .limit(1);
    return client?.redirectUrls.split(",");
  });
  return auth.handler(request);
});
