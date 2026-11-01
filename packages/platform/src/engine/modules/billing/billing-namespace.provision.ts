import { ensureNamespace } from "../../lib/openship-cloud";
import { syncOblienEntitlement, assertNamespaceHasQuota } from "./billing-oblien-quota";

/** Create identity; Oblien's default policy and paid entitlement own the grant. */
export async function provisionOrgNamespace(organizationId: string) {
  const namespace = await ensureNamespace(organizationId);
  await assertNamespaceHasQuota(organizationId);
  const { tier } = await syncOblienEntitlement(organizationId);
  return { namespace, tier };
}
