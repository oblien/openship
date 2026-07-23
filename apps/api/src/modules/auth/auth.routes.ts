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
import { db, schema } from "@repo/db";
import { env } from "../../config/env";
import { auth, isSaasDeployment } from "../../lib/auth";
import { hasValidInternalToken, internalAuth } from "../../middleware/internal-auth";
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
// FIRST account, and only from a trusted local path:
//   - loopback (CLI bootstrap / local dev), OR
//   - valid X-Internal-Token (dashboard same-origin proxy on Docker Compose —
//     the API peer is the dashboard container's bridge IP, not 127.0.0.1).
// This closes the remote first-admin race for direct hits on a published API
// port (no token → refused) while still letting `docker compose up` → open
// dashboard → create first admin work. Every other new account is created via
// the token-bound POST /api/system/invite-signup.
authRoutes.on("POST", "/sign-up/*", async (c, next) => {
  if (isSaasDeployment) return next();
  const [anyUser] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  if (!anyUser && (isLoopbackRequest(c) || hasValidInternalToken(c))) return next();
  return c.json(
    {
      error: "Public sign-up is disabled on this instance. Use your invitation link to join.",
      code: "SIGNUP_DISABLED",
    },
    403,
  );
});

// Better Auth catch-all — must be last so the desktop overrides + signup guard win.
authRoutes.on(["GET", "POST"], "/*", (c) => auth.handler(c.req.raw));
