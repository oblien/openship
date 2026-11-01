import type { BillingState } from "@repo/contracts";

export function monthlyCompute(patch: Partial<NonNullable<BillingState["compute"]>> = {}): NonNullable<BillingState["compute"]> {
  return {
    billingMode: "monthly", covered: true, status: "active", autoRenew: true,
    currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
    monthlyAmount: 4640, paygCapAmount: 5800,
    retention: { minimumDays: 30, automaticDeletion: false, reviewAt: "2026-12-01T00:00:00Z",
      storagePerGiBMonth: 0.05, amountDue: 0, currency: "usd" },
    network: { service: "managed_proxy_transfer", included: false, purchasedBytes: 0,
      consumedBytes: 0, reservedBytes: 0, availableBytes: 0 },
    savings: null, ...patch,
  };
}
