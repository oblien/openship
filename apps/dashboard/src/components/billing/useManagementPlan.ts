"use client";

import type { ManagementState } from "@repo/contracts";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { managementApi } from "@/lib/api/management";

const pendingInterval = (state: ManagementState) =>
  state.pendingCheckout || state.change ? 5_000 : 0;
const billingInterval = (state: ManagementState) => pendingInterval(state) || 60_000;

/** Connection forms only poll while a payment or allowance change needs confirmation. */
export function useManagementPlan({ refreshIdle = true }: { refreshIdle?: boolean } = {}) {
  return useScopedResource(managementApi.get, refreshIdle ? billingInterval : pendingInterval);
}

export type ManagementPlanResource = ReturnType<typeof useManagementPlan>;
