import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { ensureNamespace } from "../../lib/openship-cloud";
import { syncOblienEntitlement, assertNamespaceHasQuota } from "./billing-oblien-quota";

/** Create identity; Oblien's default policy and paid entitlement own the grant. */
export async function provisionOrgNamespace(organizationId: string) {
  const namespace = await ensureNamespace(organizationId);
  await assertNamespaceHasQuota(organizationId);
  const { tier } = await syncOblienEntitlement(organizationId);
  return { namespace, tier };
}

export async function backfillOrgNamespaces(limit = 50): Promise<{ done: number; failed: number }> {
  if (!env.CLOUD_MODE) return { done: 0, failed: 0 };
  const pending = await repos.organization.listWithoutOblienNamespace(limit);
  let done = 0;
  let failed = 0;
  for (const org of pending) {
    try {
      await provisionOrgNamespace(org.id);
      done += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[billing] namespace backfill failed for org ${org.id}: ${safeErrorMessage(error)}`);
    }
  }
  return { done, failed };
}
