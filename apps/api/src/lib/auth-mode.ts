/**
 * THE auth-mode resolver. One direct source, no inference.
 *
 * authMode decides whether a request needs a login at all, so it is read from one
 * place and never guessed. Two sources, in strict precedence:
 *
 *   1. OPENSHIP_AUTH_MODE — DECLARED by whoever launches the API. When set it is
 *      authoritative: no DB read, no cache, no fallback. The desktop app sets
 *      "none" (see apps/desktop/src/main/services.ts).
 *   2. instanceSettings.authMode — only consulted when nothing was declared. This
 *      keeps the runtime upgrades self-hosted instances genuinely need:
 *      bootstrap-admin (CLI creates the first admin → "local") and
 *      upgrade-to-auth both take effect on the next request, no restart.
 *
 * What this file deliberately no longer does, because each was a way for a
 * security decision to be reached by accident rather than by declaration:
 *
 *   - It does NOT infer from DEPLOY_MODE. Desktop is "none" because Electron says
 *     so, not because the API recognised a deployment label.
 *   - It does NOT fail open. The old code ended in `catch { cached = fallback }`
 *     where fallback was "none" on desktop — a failed DB query handed out
 *     zero-auth. The unpinned path now always falls back to "local" (fail closed),
 *     so "none" is reachable only from an explicit declaration or an explicit
 *     stored value.
 *   - It carries no per-mode heuristics. An earlier fix special-cased "downgrade a
 *     stale desktop 'cloud'"; the declaration makes that unreachable, and a
 *     heuristic here was the problem rather than the fix.
 *
 * A declaration is NOT a bypass. zeroAuthAllowed() (middleware/zero-auth-guard.ts)
 * independently re-checks the deploy mode, OPENSHIP_REQUIRE_AUTH,
 * OPENSHIP_PUBLIC_URL, OPENSHIP_ALLOW_ZERO_AUTH and — last — that the TCP peer is
 * loopback per the kernel. Declaring "none" on a network-reachable box grants
 * nothing on its own; it only makes this value honest about what the API enforces.
 *
 * Everything that needs the mode calls getAuthMode(). Re-deriving it locally is
 * what produced the drift documented in zero-auth-guard.ts (CWE-306) and, later, a
 * dashboard rendering a remote sign-in screen against an API that wanted no login.
 */

import { env } from "../config/env";

/** The canonical mode set. Shared with the env parser and the write validator so
 *  there is exactly one list. */
export const AUTH_MODES = ["none", "local", "cloud"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** The launcher-declared mode, or null when nothing was declared. */
export function pinnedAuthMode(): AuthMode | null {
  return env.OPENSHIP_AUTH_MODE ?? null;
}

/** True when the mode was declared, so the DB must not be able to contradict it. */
export function isAuthModePinned(): boolean {
  return pinnedAuthMode() !== null;
}

/** Cached ONLY for the unpinned (DB-backed) path — avoids a query per request
 *  through authMiddleware. Cleared by every authMode write. */
let cached: AuthMode | null = null;

export async function getAuthMode(): Promise<AuthMode> {
  // Declared → done. Nothing else is consulted, so there is no ordering, no
  // staleness and no failure mode to reason about.
  const pinned = pinnedAuthMode();
  if (pinned) return pinned;

  if (cached !== null) return cached;

  // Undeclared: the persisted value is the source. Fail CLOSED — an unreadable
  // settings table means "require a login", never "let everyone in".
  try {
    const { repos } = await import("@repo/db");
    const settings = await repos.instanceSettings.get();
    const stored = settings?.authMode;
    cached = AUTH_MODES.includes(stored as AuthMode) ? (stored as AuthMode) : "local";
  } catch {
    cached = "local";
  }

  return cached;
}

/** Clear the cached value - called after setup.controller writes. */
export function clearAuthModeCache() {
  cached = null;
}
