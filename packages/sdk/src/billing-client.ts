import { BillingPublicSchemas, BillingOperationSchemas, normalizeBillingCreditPacks, isRecord, type BillingOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteBillingOperations(http: HttpClient): BillingOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, BillingPublicSchemas, { listPlans: { method: "GET", path: () => "/billing/plans", envelope: "data" } }),
    ...createRemoteScopedOperations(http, BillingOperationSchemas, {
      getState: { method: "GET", path: () => "/billing/state", envelope: "data" },
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
