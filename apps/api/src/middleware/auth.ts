import type { Context, Next } from "hono";
import { auth } from "../lib/auth";

/**
 * Session authentication middleware.
 * Verifies the session via cookie or Bearer token.
 * Sets `user` and `session` on the Hono context.
 *
 * Usage:
 *   app.get("/api/projects", authMiddleware, handler);
 */
export async function authMiddleware(c: Context, next: Next) {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  await next();
}
