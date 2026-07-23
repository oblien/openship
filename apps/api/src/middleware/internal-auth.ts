import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "../config";
import { isLoopbackRequest, peerAddress } from "./loopback-peer";

/**
 * True when `X-Internal-Token` matches `INTERNAL_TOKEN` (timing-safe).
 * Used by `internalAuth` and by the empty-DB first-signup gate so the
 * dashboard same-origin proxy can vouch for Docker-compose signup without
 * widening `isLoopbackRequest` to RFC1918 peers.
 */
export function hasValidInternalToken(c: Context): boolean {
  if (!env.INTERNAL_TOKEN) return false;
  const token = c.req.header("X-Internal-Token");
  if (!token) return false;

  const expected = Buffer.from(env.INTERNAL_TOKEN, "utf-8");
  const received = Buffer.from(token, "utf-8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

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

  if (!hasValidInternalToken(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
