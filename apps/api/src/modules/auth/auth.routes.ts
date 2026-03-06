import { Hono } from "hono";
import { auth } from "../../lib/auth";

export const authRoutes = new Hono();

/**
 * All auth endpoints are handled by Better Auth.
 * This catches every method + path under /api/auth/*.
 *
 * Endpoints provided by Better Auth:
 *
 *   POST /api/auth/sign-up/email    — Register with email + password
 *   POST /api/auth/sign-in/email    — Login with email + password
 *   GET  /api/auth/sign-in/social   — OAuth redirect (?provider=github|google)
 *   GET  /api/auth/callback/:provider — OAuth callback
 *   POST /api/auth/sign-out         — Logout (revoke session)
 *   GET  /api/auth/session          — Get current session + user
 */
authRoutes.on(["GET", "POST"], "/*", (c) => {
  return auth.handler(c.req.raw);
});
