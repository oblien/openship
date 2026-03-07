import type { Context, Next } from "hono";

/**
 * Rate-limiting middleware.
 * Uses a simple in-memory store (swap for Redis in production).
 */
const requestCounts = new Map<string, { count: number; resetAt: number }>();

export async function rateLimiter(c: Context, next: Next) {
  const path = c.req.path;
  
  // Skip rate limiting for get-session - it's a safe read-only endpoint
  // that gets called frequently on page navigations
  if (path === "/api/auth/get-session") {
    await next();
    return;
  }
  
  const ip = c.req.header("x-forwarded-for") || "unknown";
  const now = Date.now();
  const window = 60_000; // 1 minute
  const maxRequests = 100;

  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + window });
  } else if (entry.count >= maxRequests) {
    return c.json({ error: "Too many requests" }, 429);
  } else {
    entry.count++;
  }

  await next();
}
