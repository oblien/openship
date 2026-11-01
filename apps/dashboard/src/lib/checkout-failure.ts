import type { PlanTierId } from "@repo/core";
import type { CustomSubscriptionSelection } from "@repo/contracts";
import { ApiError, getApiErrorCode } from "./api/client";

export interface CheckoutFailure {
  kind: "capacity" | "checkout";
  requestId: string;
  planTierId: PlanTierId;
  interval: "monthly" | "annual";
  workspaceId?: string;
  custom?: CustomSubscriptionSelection;
}

/** Availability is a recoverable purchase state, not an invalid form value. */
export function checkoutFailureKind(error: unknown): CheckoutFailure["kind"] | null {
  const code = getApiErrorCode(error);
  if (code === "CLOUD_CAPACITY_UNAVAILABLE") return "capacity";
  if (error instanceof ApiError) {
    const body = error.body as { providerCode?: string; details?: { providerCode?: string } } | null;
    if ([body?.providerCode, body?.details?.providerCode].some(value =>
      value === "capacity_unavailable" || value === "billing_capacity_unavailable")) return "capacity";
  }
  return code && ["OBLIEN_CHECKOUT_UNAVAILABLE", "OBLIEN_BILLING_UNAVAILABLE", "BILLING_NOT_CONFIGURED", "BILLING_NOT_ENABLED"].includes(code)
    ? "checkout" : null;
}
