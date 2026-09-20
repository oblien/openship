import type { Context, Next } from "hono";
import { trustedOrigins } from "@repo/platform/engine/config/env";

/**
 * CSRF defence via Origin-header check.
 *
 * Same-site cookies + crossSubDomainCookies open us up to CSRF from a
 * sibling subdomain. The fix is the same one Stripe, GitHub, and every
 * other cookie-auth API runs: REJECT any state-changing request whose
 * Origin header isn't in our `trustedOrigins` allowlist.
 *
 * Policy:
 *   - GET / HEAD / OPTIONS → pass (safe methods, no state change).
 *   - Missing Origin (curl, server-to-server, CLI tools using Bearer)
 *     → pass. Authentication layer handles those — they don't ship
 *     ambient cookies, so they aren't a CSRF vector.
 *   - Origin in trustedOrigins → pass.
 *   - Anything else → 403 ORIGIN_REJECTED.
 *
 * Mounted in app.ts BEFORE the auth middleware so requests with a
 * forged Origin never even touch the session resolver.
 *
 * Webhook routes (Stripe, Oblien, backups) authenticate via their own
 * HMAC signatures and are mounted under r.public() — they never reach
 * this middleware because the auth chain skips them entirely.
 */
export async function originGuard(c: Context, next: Next) {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  const origin = c.req.header("origin");
  if (!origin) {
    // No Origin header — almost certainly a non-browser caller (curl,
    // CLI, server-to-server). Browsers send Origin on every fetch
    // since 2022. Auth layer enforces credentials separately.
    return next();
  }

  if (!trustedOrigins.includes(origin)) {
    return c.json(
      { error: "Origin not allowed", code: "ORIGIN_REJECTED" },
      403,
    );
  }

  return next();
}
