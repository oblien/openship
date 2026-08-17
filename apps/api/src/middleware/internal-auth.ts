import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "../config";
import { isLoopbackRequest, peerAddress } from "./loopback-peer";

/**
 * Middleware that validates the internal token for Electron → API calls.
 *
 * The desktop app generates a shared secret on first run and passes it
 * to the API via INTERNAL_TOKEN. Cloud / docker / bare deployments
 * MUST have INTERNAL_TOKEN set — env.ts refuses to boot otherwise (see
 * CRITICAL #5). The runtime check below is belt-and-suspenders for
 * the unlikely case where boot validation was bypassed (e.g. a future
 * dynamic config path that updates env late):
 *
 *   - DEPLOY_MODE !== "desktop"  → INTERNAL_TOKEN required; missing
 *                                  token, missing header, or bad
 *                                  match → 401.
 *   - DEPLOY_MODE === "desktop"  → INTERNAL_TOKEN is optional. When
 *                                  unset, the request MUST come from
 *                                  a loopback TCP peer (kernel-
 *                                  reported, not Host header).
 *
 * Uses timing-safe comparison to prevent side-channel leakage on the
 * normal path.
 *
 * The refusal body is exactly `{"error":"Unauthorized"}`, and the CLI reads it:
 * lib/loopback-api's internalFetch treats THAT shape (and only it) as "the token was
 * refused, before any handler ran", which is what makes retrying with this box's other
 * token safe. A handler's own 401 — /cloud-connect after a single-use PKCE exchange —
 * must stay distinguishable from this one, so keep the wording.
 */
export async function internalAuth(c: Context, next: Next) {
  if (!env.INTERNAL_TOKEN) {
    // Boot guard in env.ts already prevents this on non-desktop. If
    // we still get here without a token in any non-desktop mode, refuse.
    if (env.DEPLOY_MODE !== "desktop") {
      console.error(
        "[internal-auth] INTERNAL_TOKEN unset on non-desktop deployment — refusing.",
      );
      return c.json({ error: "Unauthorized" }, 401);
    }
    // Desktop fallback: trust loopback peer (kernel-reported address).
    // Same guarantee as the zero-auth path in authMiddleware: an
    // Electron child process talking to its bundled API on 127.0.0.1
    // is the only caller we accept without a token.
    if (!isLoopbackRequest(c)) {
      console.warn(
        `[internal-auth] desktop loopback gate refused peer=${peerAddress(c) ?? "<unknown>"}`,
      );
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
    return;
  }

  const token = c.req.header("X-Internal-Token");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Timing-safe comparison - prevents response-time side-channel attacks.
  const expected = Buffer.from(env.INTERNAL_TOKEN, "utf-8");
  const received = Buffer.from(token, "utf-8");

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
