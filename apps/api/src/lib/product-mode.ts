/**
 * THE product-mode resolver — which product this instance presents itself as.
 *
 *   "platform" → the full deploy platform (default)
 *   "mail"     → Openship Mail: the dashboard's left rail becomes the mail
 *                control plane and the platform nav is hidden
 *
 * Precedence:
 *   1. CLOUD_MODE → always "platform", unconditionally. The entire /api/mail
 *      mount is localOnly (modules/mail/mail.routes.ts), so a mail-mode SaaS
 *      shell would render a rail of links that all 403. Not a preference.
 *   2. instance_settings.product_mode — the operator's dashboard toggle.
 *   3. OPENSHIP_PRODUCT — the launcher-declared instance default.
 *
 * NOTE the precedence is the OPPOSITE of getAuthMode() (lib/auth-mode.ts), which
 * sits next door and lets env PIN the value against the DB. That asymmetry is
 * deliberate: authMode is a security decision, so a declaration must not be
 * overridable by a database write. Product mode is presentation, and the whole
 * point of the settings row is that flipping the toggle takes effect without
 * editing env and restarting the API. If this ever starts gating a route, that
 * reasoning no longer holds and the precedence has to be revisited.
 *
 * Mail mode is a nav + branding SCOPE, never an authorization boundary. Nothing
 * downstream may refuse a request because of it: the mail installer is the deploy
 * machinery, and webmail ships as an ordinary catalog app through the standard
 * pipeline (modules/mail/webmail/webmail-install.service.ts), so gating the
 * platform endpoints on mail mode would break mail itself.
 */

import { env } from "../config/env";

/** The canonical mode set. Shared with the env parser and the write validator so
 *  there is exactly one list. */
export const PRODUCT_MODES = ["platform", "mail"] as const;
export type ProductMode = (typeof PRODUCT_MODES)[number];

export function isProductMode(value: unknown): value is ProductMode {
  return PRODUCT_MODES.includes(value as ProductMode);
}

/** Cached because /health/env is unauthenticated and polled by every dashboard
 *  load. Cleared by every instance-settings write. */
let cached: ProductMode | null = null;
let cacheGeneration = 0;

export async function resolveProductMode(): Promise<ProductMode> {
  // Multi-tenant SaaS: mail is self-hosted-only infrastructure. Checked first so
  // no stored value or env var can produce a dead rail on the cloud.
  if (env.CLOUD_MODE) return "platform";

  if (cached !== null) return cached;
  const generation = cacheGeneration;

  // Unreadable settings fall back to the env default rather than failing closed.
  // This value picks which nav to draw; there is nothing to fail closed ABOUT,
  // and refusing to honour a declared OPENSHIP_PRODUCT=mail because one query
  // failed would show a mail-only operator a platform UI they can't use.
  let resolved: ProductMode;
  try {
    const { repos } = await import("@repo/db");
    const stored = (await repos.instanceSettings.get())?.productMode;
    resolved = isProductMode(stored) ? stored : env.OPENSHIP_PRODUCT;
  } catch {
    resolved = env.OPENSHIP_PRODUCT;
  }

  if (generation === cacheGeneration) cached = resolved;
  return resolved;
}

/** Clear the cached value — called after setup.controller writes. */
export function clearProductModeCache() {
  cacheGeneration += 1;
  cached = null;
}
