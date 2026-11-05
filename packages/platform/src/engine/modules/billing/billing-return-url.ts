import { runtimeTarget } from "../../config/env";

/** A hosted payment must return to the organization that initiated it. */
export function billingReturnUrl(
  tab: "overview" | "plans" | "manage",
  organizationId: string,
  workspaceId?: string,
): string {
  const url = new URL(`/billing/${tab}`, runtimeTarget.dashboard);
  url.searchParams.set("organizationId", organizationId);
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  return url.toString();
}

/** Reuse pre-upgrade URLs verbatim under their original provider idempotency key.
 * Only adding this owner's organization scope is compatible; all other request
 * fields are still checked by the checkout owner's strict comparison. */
export function preserveCheckoutReturnUrls<T extends { successUrl?: string; cancelUrl?: string }>(
  requested: T,
  saved: { successUrl?: string; cancelUrl?: string } | undefined,
  organizationId: string,
): T {
  if (!saved) return requested;
  const compatible = (next: string | undefined, previous: string | undefined) => {
    if (next === previous) return true;
    if (!next || !previous) return false;
    const current = new URL(next);
    const original = new URL(previous);
    if (
      original.searchParams.has("organizationId") ||
      current.searchParams.getAll("organizationId").length !== 1 ||
      current.searchParams.get("organizationId") !== organizationId
    )
      return false;
    current.searchParams.delete("organizationId");
    current.searchParams.sort();
    original.searchParams.sort();
    return current.toString() === original.toString();
  };
  return compatible(requested.successUrl, saved.successUrl) &&
    compatible(requested.cancelUrl, saved.cancelUrl)
    ? { ...requested, successUrl: saved.successUrl, cancelUrl: saved.cancelUrl }
    : requested;
}
