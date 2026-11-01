import { PLAN_IDS, resolvePlan, toPricingLocale } from "@repo/core";

/** Keep the execution identity in Cloud space links, not the subscription ID. */
export function cloudSpaceHref(serverId: string, tab?: "activity") {
  const query = new URLSearchParams({ pool: serverId });
  if (tab) query.set("tab", tab);
  return `/resources?${query}`;
}

/** Use catalog names without silently calling an unknown offer Free. */
export function cloudSpacePlanLabel(planId: string, locale: string, fallback: string) {
  const known = PLAN_IDS.find((id) => id === planId);
  return known ? resolvePlan(known, toPricingLocale(locale)).name : fallback;
}
