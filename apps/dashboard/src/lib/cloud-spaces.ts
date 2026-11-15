import { PLAN_IDS, resolvePlan, toPricingLocale } from "@repo/core";

export type CloudPlanTab = "overview" | "usage" | "payment" | "activity" | "topups";

/** A plan keeps its execution identity, including billing and checkout-return links. */
export function cloudSpaceHref(serverId: string, tab?: CloudPlanTab, params?: URLSearchParams) {
  const query = new URLSearchParams(params);
  query.delete("workspaceId");
  query.delete("newServer");
  query.set("pool", serverId);
  if (tab && tab !== "overview") query.set("tab", tab);
  else query.delete("tab");
  return `/resources?${query}`;
}

/** Use catalog names without silently calling an unknown offer Free. */
export function cloudSpacePlanLabel(planId: string, locale: string, fallback: string) {
  const known = PLAN_IDS.find((id) => id === planId);
  return known ? resolvePlan(known, toPricingLocale(locale)).name : fallback;
}
