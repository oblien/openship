import type { BillingState } from "./api/billing";

/** Complimentary grants provide a plan without a paid provider subscription. */
export function needsCloudPlan(state: Pick<BillingState, "tier" | "subscription" | "complimentary">): boolean {
  if (state.complimentary) return false;
  if (state.subscription) return state.subscription.status === "canceled";
  return state.tier === "free" || state.subscription === null;
}

export function hasUnlimitedCloudCredits(state: BillingState): boolean {
  return state.tier === "enterprise" && !needsCloudPlan(state) && state.status === "active" && state.balance.unlimited === true;
}

/** Usage has a percentage only when the provider supplies a finite allowance. */
export function cloudUsagePercent(state: BillingState): number | null {
  const { quotaLimit, quotaUsed } = state.balance;
  if (quotaLimit === null || quotaLimit <= 0 || !Number.isFinite(quotaLimit) || !Number.isFinite(quotaUsed)) return null;
  return Math.min(100, Math.max(0, quotaUsed / quotaLimit * 100));
}

/** Do not hide invoices or purchased credits from an earlier billing customer. */
export function isNewCloudCustomer(state: BillingState): boolean {
  return state.tier === "free" && state.subscription == null && !state.complimentary
    && !state.workspace?.provisioned
    && (state.capacity?.workspaces?.used ?? 0) === 0
    && state.balance.quotaUsed === 0 && (state.balance.quotaRemaining ?? 0) === 0
    && (state.balance.quotaLimit ?? 0) === 0;
}
