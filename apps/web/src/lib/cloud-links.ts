import { CLOUD_DASHBOARD_URL } from "@repo/core";

/** Cloud owns authentication and checkout; keep the purchase intent in its URL. */
export function cloudPlanHref(planId?: string, interval?: "monthly" | "annual"): string {
  const url = new URL("/billing/plans", CLOUD_DASHBOARD_URL);
  url.searchParams.set("newServer", "1");
  if (planId) {
    url.searchParams.set("plan", planId);
    url.searchParams.set("startCheckout", "1");
    if (interval) url.searchParams.set("interval", interval);
  }
  return url.toString();
}

export function managePlanHref(plan?: "basic" | "priority"): string {
  const url = new URL("/billing/manage", CLOUD_DASHBOARD_URL);
  if (plan) url.searchParams.set("plan", plan);
  return url.toString();
}
