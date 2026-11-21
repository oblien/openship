import { reportCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { withCloudBillingLock } from "./billing-oblien-quota";
import { readProviderBilling } from "./billing-plan-grants";

const DRAFT_IDLE_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 25;
let cursor: string | undefined;

/** Reclaim unused purchase identities after the retry window. Provider reads
 * verify payment state without recovering a lost create response. */
export async function runCheckoutDraftCleanup() {
  const stats = { scanned: 0, removed: 0, errors: 0 };
  if (!env.CLOUD_MODE) return stats;
  const before = new Date(Date.now() - DRAFT_IDLE_MS);
  const candidates = await repos.cloudWorkspace.listAbandonedCheckoutDrafts(before, cursor, BATCH_SIZE);
  cursor = candidates.length === BATCH_SIZE ? candidates.at(-1)!.id : undefined;

  for (const { id, organizationId } of candidates) {
    stats.scanned++;
    try {
      const removed = await withCloudBillingLock(organizationId, async () => {
        const row = await repos.cloudWorkspace.findByIdInOrganization(id, organizationId);
        if (!row || row.updatedAt >= before) return false;
        if (row.namespace) {
          const billing = getOblienBillingApi();
          for (const intent of row.pendingCheckouts) {
            if (!intent.checkoutId) return false;
            const { checkout } = await billing.getCheckout(row.namespace, intent.checkoutId);
            if (checkout.status !== "expired" || checkout.paymentStatus !== "unpaid" || checkout.fulfilled)
              return false;
          }
          const [{ pendingCheckout }, { subscription, entitlement }, grant] = await Promise.all([
            billing.getPendingCapacityCheckout(row.namespace),
            readProviderBilling(billing, row.namespace),
            repos.billingPlanGrant.current(organizationId, row.namespace),
          ]);
          const { quota, tierId } = entitlement;
          if (pendingCheckout || subscription || grant || (tierId !== null && tierId !== "free") ||
            entitlement.computeCovered || quota.balance !== 0 || quota.used !== 0 || quota.limit !== 0)
            return false;
        } else if (row.pendingCheckouts.length) {
          return false;
        }
        return repos.cloudWorkspace.deleteAbandonedCheckoutDraft(id, organizationId, row.namespace, before);
      }, id);
      if (removed) stats.removed++;
    } catch (error) {
      stats.errors++;
      reportCaughtError(error, "platform/engine/modules/billing/checkout-draft-cleanup");
    }
  }
  return stats;
}
