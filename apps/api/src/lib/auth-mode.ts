/**
 * Cached auth-mode reader for desktop mode.
 *
 * Auth mode is written once during onboarding and rarely changes.
 * Caching avoids a DB hit on every request through authMiddleware.
 *
 * The cache is cleared by setup.controller after any write so that
 * re-onboarding (dev reset) picks up the new value immediately.
 */

import { env } from "../config/env";

let cached: string | null = null;

/**
 * Returns the current auth mode for this instance.
 *
 *   "none"  → zero-auth desktop (auto-provisioned local user)
 *   "cloud" → cloud-authenticated desktop (Openship Cloud session)
 *   "local" → standard Better Auth (self-hosted VPS / SaaS)
 */
export async function getAuthMode(): Promise<"none" | "cloud" | "local"> {
  // Non-desktop always uses local Better Auth
  if (env.DEPLOY_MODE !== "desktop") return "local";

  if (cached !== null) return cached as "none" | "cloud" | "local";

  try {
    const { repos } = await import("@repo/db");
    const settings = await repos.instanceSettings.get();
    cached = settings?.authMode ?? "none";
  } catch {
    cached = "none";
  }

  return cached as "none" | "cloud" | "local";
}

/** Clear the cached value — called after setup.controller writes. */
export function clearAuthModeCache() {
  cached = null;
}
