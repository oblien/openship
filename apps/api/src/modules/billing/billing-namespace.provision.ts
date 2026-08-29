/**
 * Namespace provisioning — the step that makes every Oblien ceiling real.
 *
 * Openship Cloud is a wrapper over Oblien: a plan IS "these credits plus these
 * resource ceilings on your namespace", and Oblien enforces both. That only works
 * if Oblien has been told the namespace exists AND what its limits are.
 *
 * Two gaps this closes, both of which made the entire entitlement path inert:
 *
 *   1. `organization.oblien_namespace` was never persisted, so every quota helper
 *      short-circuited on `if (!org.oblienNamespace) return`. Fixed in
 *      `ensureNamespace` (which now writes the column DB-first).
 *   2. Ceilings were pushed ONLY from Stripe webhooks and the anniversary cron.
 *      A FREE org never touches Stripe, and the cron skips rows whose
 *      `current_period_end` is NULL — which is every free org. So free
 *      namespaces ran with NO credit quota and NO resource ceiling at all: fully
 *      metered, joinable, and uncapped.
 *
 * `ensureNamespace` and `setQuotaForTier` are paired deliberately. A recorded
 * namespace with no quota row is worse than no namespace: it looks provisioned,
 * it accrues spend, and nothing stops it.
 */

import { DEFAULT_PLAN_TIER, safeErrorMessage, type PlanTierId } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { ensureNamespace } from "../../lib/openship-cloud";
import { setQuotaForTier } from "./billing-oblien-quota";

/**
 * Ensure the org has an Oblien namespace AND that its tier's ceilings are pushed.
 *
 * Idempotent end to end: `namespaces.ensure` adopts an existing namespace and
 * `setQuota`/`namespaces.update` are both upserts, so calling this on every org
 * creation and again at boot is safe.
 */
export async function provisionOrgNamespace(
  organizationId: string,
  tierId?: PlanTierId,
): Promise<{ namespace: string; tier: PlanTierId }> {
  const namespace = await ensureNamespace(organizationId);

  const tier =
    tierId ??
    ((await repos.organization.findById(organizationId))?.planTierId as PlanTierId | undefined) ??
    DEFAULT_PLAN_TIER;

  await setQuotaForTier(organizationId, tier);
  return { namespace, tier };
}

/**
 * Boot sweep for orgs created before namespaces were persisted.
 *
 * Bounded and sequential: this runs on every cloud boot, the tail only needs
 * draining once, and firing hundreds of concurrent Oblien calls at startup would
 * be a worse failure than taking a few boots to finish. Per-org failures are
 * logged and skipped — one unreachable namespace must not stop the sweep or the
 * boot.
 */
export async function backfillOrgNamespaces(limit = 50): Promise<{ done: number; failed: number }> {
  if (!env.CLOUD_MODE) return { done: 0, failed: 0 };

  const pending = await repos.organization.listWithoutOblienNamespace(limit).catch(() => []);
  let done = 0;
  let failed = 0;

  for (const org of pending) {
    try {
      await provisionOrgNamespace(org.id);
      done += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[billing] namespace backfill failed for org ${org.id}: ${safeErrorMessage(err)}`,
      );
    }
  }

  return { done, failed };
}
