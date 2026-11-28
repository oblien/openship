import { isDedicatedMailNamespace } from "../managed-mail/dedicated-contract";
import { repos } from "@repo/db";
import { getOblienBillingApi } from "../../lib/oblien-client";

/** Provider-backed Cloud coverage, including legacy paid subscriptions. A paid
 * sibling is sufficient; an unavailable provider is never treated as cancellation. */
export async function paidComputeCoverage(org: string): Promise<Date | null> {
  const [organization, workspaces] = await Promise.all([
    repos.organization.findById(org),
    repos.cloudWorkspace.listByOrganization(org),
  ]);
  const namespaces = new Set(
    [
      organization?.oblienNamespace,
      ...workspaces
        .filter((row) => !row.remote && !row.deletionInProgress && !isDedicatedMailNamespace(row.namespace))
        .map((row) => row.namespace),
    ].filter((value): value is string => !!value),
  );
  const results = await Promise.allSettled(
    [...namespaces].map((namespace) => getOblienBillingApi().getEntitlement(namespace)),
  );
  let end = 0;
  for (const result of results)
    if (
      result.status === "fulfilled" &&
      result.value.tierId !== "free" &&
      result.value.billingMode !== "service" &&
      result.value.status === "active"
    )
      end = Math.max(end, Date.parse(result.value.periodEnd ?? "") || 0);
  if (end > Date.now()) return new Date(end);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return null;
}
