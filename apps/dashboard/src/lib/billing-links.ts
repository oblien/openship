export interface BillingLinkScope {
  workspaceId?: string | null;
  organizationId?: string | null;
}

/** Preserve checkout reconciliation and organization scope through entry redirects. */
export function billingTabHref(tab: "overview" | "plans", query: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  }
  const search = params.toString();
  return `/billing/${tab}${search ? `?${search}` : ""}`;
}

/** Keep the chosen subscription and organization through billing navigation. */
export function scopedBillingHref(path: string, { workspaceId, organizationId }: BillingLinkScope = {}) {
  const url = new URL(path, "https://openship.invalid");
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  if (organizationId) url.searchParams.set("organizationId", organizationId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function workspaceBillingHref(path: string, workspaceId?: string | null) {
  return scopedBillingHref(path, { workspaceId });
}
