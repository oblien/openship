import type { Context } from "hono";
import { env } from "@repo/platform/engine/config/env";
import { getAuthMode } from "@repo/platform/engine/lib/auth-mode";
import { isLoopbackRequest, peerAddress } from "./loopback-peer";

/**
 * Single source of truth for "may the zero-auth synthetic-admin path run for
 * THIS request?". Used by BOTH:
 *   - authMiddleware (grants an implicit zero-auth session), and
 *   - the public POST /system/upgrade-to-auth bootstrap route.
 *
 * These two used to gate zero-auth independently, and they drifted: the upgrade
 * route defaulted a missing settings row to "none" while the middleware (via
 * getAuthMode) defaults a fresh self-hosted install to "local". That let an
 * unauthenticated network peer win the first-admin race on a published port
 * (CWE-306). Both now call this, so they cannot diverge again.
 *
 * Zero-auth is permitted ONLY when ALL hold:
 *   - resolved authMode === "none" (canonical getAuthMode, never a raw default)
 *   - not CLI-managed / publicly-served (OPENSHIP_REQUIRE_AUTH / OPENSHIP_PUBLIC_URL)
 *   - desktop, or OPENSHIP_ALLOW_ZERO_AUTH explicitly opted in
 *   - the TCP peer is loopback (kernel-reported, unspoofable)
 */
export async function zeroAuthAllowed(
  c: Context,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mode = await getAuthMode();
  if (mode !== "none") return { ok: false, reason: `authMode=${mode}` };

  if (env.OPENSHIP_REQUIRE_AUTH || env.OPENSHIP_PUBLIC_URL) {
    return { ok: false, reason: "cli-managed-or-publicly-served" };
  }
  if (env.DEPLOY_MODE !== "desktop" && !env.OPENSHIP_ALLOW_ZERO_AUTH) {
    return { ok: false, reason: `deploy-mode=${env.DEPLOY_MODE} without OPENSHIP_ALLOW_ZERO_AUTH` };
  }
  if (!isLoopbackRequest(c)) {
    return { ok: false, reason: `non-loopback peer=${peerAddress(c) ?? "<unknown>"}` };
  }
  return { ok: true };
}
