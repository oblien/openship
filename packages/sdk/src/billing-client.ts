import { BillingPublicSchemas, BillingOperationSchemas, normalizeBillingCreditPacks, isRecord, type BillingOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteBillingOperations(http: HttpClient): BillingOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, BillingPublicSchemas, { listPlans: { method: "GET", path: () => "/billing/plans", envelope: "data" } }),
    ...createRemoteScopedOperations(http, BillingOperationSchemas, {
      getActionsBudget: { method: "GET", path: () => "/billing/actions", envelope: "data" },
      getActionsPurchase: { method: "GET", path: () => "/billing/actions/purchase", envelope: "data" },
      createActionsCheckout: { method: "POST", path: () => "/billing/actions/checkout", envelope: "data" },
      resumeActionsCheckout: { method: "POST", path: () => "/billing/actions/checkout/resume", envelope: "data" },
      quoteCustomPlan: { method: "GET", path: () => "/billing/subscription/quote", envelope: "data" },
      previewSubscriptionChange: { method: "POST", path: () => "/billing/subscription/change/preview", envelope: "data" },
      confirmSubscriptionChange: { method: "POST", path: () => "/billing/subscription/change", envelope: "data" },
      getSubscriptionChange: { method: "GET", path: () => "/billing/subscription/change", envelope: "data" },
      cancelSubscriptionChange: { method: "POST", path: () => "/billing/subscription/change/cancel", envelope: "data" },
      getCheckout: { method: "GET", path: () => "/billing/checkout", envelope: "data" },
      listCheckouts: { method: "GET", path: () => "/billing/checkouts", envelope: "data" },
      resumeCheckout: { method: "POST", path: () => "/billing/checkout/resume", envelope: "data" },
      cancelCheckout: { method: "POST", path: () => "/billing/checkout/cancel", envelope: "data" },
      getState: { method: "GET", path: () => "/billing/state", envelope: "data" },
      getCreditAlerts: { method: "GET", path: () => "/billing/credit-alerts", envelope: "data" },
      getResources: { method: "GET", path: () => "/billing/resources", envelope: "data" },
      getSubscription: { method: "GET", path: () => "/billing/subscription", envelope: "data" },
      createSubscription: { method: "POST", path: () => "/billing/subscription", envelope: "data" },
      cancelSubscription: { method: "POST", path: () => "/billing/cancel", envelope: "data" },
      resumeSubscription: { method: "POST", path: () => "/billing/resume", envelope: "data" },
      createTopup: { method: "POST", path: () => "/billing/topup", envelope: "data" },
      listTopupPacks: { method: "GET", path: () => "/billing/topup-packs", response: body => normalizeBillingCreditPacks(isRecord(body) ? body.data : undefined) },
      createPortal: { method: "POST", path: () => "/billing/portal", envelope: "data" },
      getUsage: { method: "GET", path: () => "/billing/usage", envelope: "data" },
      listAllowanceDetail: { method: "GET", path: () => "/billing/allowances", envelope: "data" },
    }),
  });
}
