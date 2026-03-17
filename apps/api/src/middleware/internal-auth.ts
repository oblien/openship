import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "../config";

/**
 * Middleware that validates the internal token for Electron → API calls.
 *
 * The desktop app generates a shared secret on first run and passes it
 * to the API via the INTERNAL_TOKEN env var. This allows Electron to push
 * system settings (SSH, tunnel, build mode) directly without user auth.
 *
 * Uses timing-safe comparison to prevent side-channel leakage.
 *
 * Expects: `X-Internal-Token: <token>` header.
 */
export async function internalAuth(c: Context, next: Next) {
  // If no internal token is configured, allow the request.
  // localOnly middleware (applied before this) already blocks cloud mode.
  // Self-hosted users control their own machine — localhost trust is standard.
  if (!env.INTERNAL_TOKEN) {
    await next();
    return;
  }

  const token = c.req.header("X-Internal-Token");

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Timing-safe comparison — prevents response-time side-channel attacks
  const expected = Buffer.from(env.INTERNAL_TOKEN, "utf-8");
  const received = Buffer.from(token, "utf-8");

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
