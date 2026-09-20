/**
 * Shared Stripe singleton — pinned API version, lazy-initialized.
 *
 * Why a singleton:
 *   - The Stripe SDK opens a connection pool per instance; one process
 *     should hold one client. Old call-sites scattered local
 *     `new Stripe(...)` calls and each lazy-cached its own — moving
 *     them onto this module makes the pool actually shared.
 *   - Pinning `apiVersion` is the whole reason this file exists.
 *     Without a pin, Stripe upgrades the wire contract under us on
 *     their schedule (e.g. fields disappear from sub objects, new
 *     enum values land in `subscription.status`). Pin it here so a
 *     dependency bump can't silently change the contract — bumping
 *     requires a re-test of the full webhook surface AND this
 *     constant.
 *
 * Bump checklist when raising `STRIPE_API_VERSION`:
 *   1. Re-test `customer.subscription.*` flows end-to-end (including
 *      the `incomplete` / `trialing` / `paused` paths that map onto
 *      our canonical enum).
 *   2. Re-verify `current_period_start` / `current_period_end` still
 *      live on the subscription root (they migrated to items in some
 *      versions — `periodStart` / `periodEnd` in billing.webhooks
 *      relies on the subscription-root location).
 *   3. Re-test invoice.paid / invoice.payment_failed metadata shape.
 *
 * Cloud-only — self-hosted instances never reach this code path
 * because billing routes are CLOUD_MODE-gated upstream.
 */

import Stripe from "stripe";
import { env } from "../config/env";

/**
 * Pinned Stripe API version. Cast to match the SDK's
 * `LatestApiVersion` literal — the SDK enforces "must be latest", but
 * we accept the cast so a Stripe SDK upgrade can't silently re-pin us
 * without an intentional bump of this constant. Re-test the webhook
 * surface (see header) when changing.
 */
export const STRIPE_API_VERSION = "2024-12-18.acacia" as unknown as Stripe.LatestApiVersion;

let _stripe: Stripe | null = null;

/**
 * Return the process-wide Stripe client. Throws when STRIPE_SECRET_KEY
 * is not configured — the only legitimate callers are CLOUD_MODE
 * billing paths, which require the secret by definition.
 */
export function stripe(): Stripe {
  if (_stripe) return _stripe;

  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  }

  _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  });
  return _stripe;
}

/**
 * Test-only reset of the cached client. Production callers must use
 * `stripe()`. Exported for unit tests that swap STRIPE_SECRET_KEY
 * between cases.
 */
export function __resetStripeClientForTests(): void {
  _stripe = null;
}
