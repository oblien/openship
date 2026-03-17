import type { Context, Next } from "hono";
import { auth } from "../lib/auth";
import { env } from "../config/env";
import { ensureLocalUser } from "../lib/local-user";

/**
 * Session authentication middleware.
 *
 * - Desktop: try real Better Auth session first (cloud-authenticated users),
 *            fall back to zero-auth local admin if no session exists.
 * - Self-hosted: validates Better Auth session (email/password registration).
 * - SaaS (CLOUD_MODE): validates Better Auth session (standard flow).
 *
 * Supports both cookie-based sessions (dashboard) and Bearer tokens (CLI/API).
 *
 * Usage:
 *   app.get("/api/projects", authMiddleware, handler);
 */
export async function authMiddleware(c: Context, next: Next) {
  /* Desktop mode: try real session first, fall back to zero-auth */
  if (env.DEPLOY_MODE === "desktop") {
    try {
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session) {
        c.set("user", session.user);
        c.set("session", session.session);
        return next();
      }
    } catch {
      // No valid session — fall through
    }

    // Zero-auth fallback — only when authMode is "none" (self-hosted desktop).
    // Cloud-auth users must re-authenticate via Openship Cloud.
    const { getAuthMode } = await import("../lib/auth-mode");
    const authMode = await getAuthMode();
    if (authMode !== "none") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await ensureLocalUser();
    c.set("user", user);
    c.set("session", { id: "desktop", userId: user.id });
    return next();
  }

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
