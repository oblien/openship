import { Type, type Static } from "@sinclair/typebox";
import { PLAN_IDS, RESOURCE_TIER_ORDER, WORKLOAD_TYPES } from "@repo/core";
import { BillingScopeSchema, CreateSubscriptionBody, CreateTopupBody, CustomServerResourcesSchema, PreviewSubscriptionChangeBody, ConfirmSubscriptionChangeBody, SubscriptionChangeScopeSchema } from "./billing-inputs";
import { CloudWorkspaceResizePreviewSchema, CloudWorkspaceSchema } from "./cloud-workspaces";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";
import { ActionBillingOperationSchemas } from "./action-billing";

const numberOrNull = Type.Union([Type.Number(), Type.Null()]);
const stringOrNull = Type.Union([Type.String(), Type.Null()]);
const tier = Type.Union(PLAN_IDS.map(id => Type.Literal(id)));
const meter = Type.Object({ used: numberOrNull, max: numberOrNull });
const currentPeriod = Type.Object({ start: stringOrNull, end: stringOrNull });
const resourcePeriod = Type.Object({ start: Type.String(), end: Type.String() });
const resourceStatus = Type.Union([Type.Literal("available"), Type.Literal("unavailable")]);
const edgeLimits = Type.Object({ bandwidthGb: numberOrNull });
export const BillingResourcesSchema = Type.Object({
  measuredAt: Type.String(),
  compute: Type.Object({
    status: resourceStatus, period: resourcePeriod,
    cpuHours: numberOrNull, memoryGbHours: numberOrNull, diskIoGb: numberOrNull, networkGb: numberOrNull,
  }),
  edge: Type.Object({
    status: resourceStatus, period: resourcePeriod, limits: edgeLimits,
    requests: numberOrNull, bandwidthGb: numberOrNull, inboundGb: numberOrNull, outboundGb: numberOrNull,
  }),
});
const planLimits = Type.Object({
  workloads: Type.Array(Type.Union(WORKLOAD_TYPES.map(value => Type.Literal(value)))),
  services: Type.Boolean(), runningServices: numberOrNull, maxProjects: numberOrNull,
  maxResourceTier: Type.Union([...RESOURCE_TIER_ORDER.map(value => Type.Literal(value)), Type.Null()]),
  maxServiceResources: Type.Optional(Type.Union([Type.Object({
    cpuCores: Type.Number({ exclusiveMinimum: 0 }), memoryMb: Type.Integer({ exclusiveMinimum: 0 }),
  }, { additionalProperties: false }), Type.Null()])),
  computeMinutesPerMonth: numberOrNull, buildMinutesPerMonth: numberOrNull,
  freeSubdomains: numberOrNull, customDomains: numberOrNull, seats: numberOrNull,
});
const capacityLimit = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const namespaceResourceLimits = Type.Object({
  max_workspaces: capacityLimit, max_vcpus: capacityLimit, max_ram_mb: capacityLimit, max_disk_gb: capacityLimit,
  max_total_vcpus: capacityLimit, max_total_ram_mb: capacityLimit, max_total_disk_gb: capacityLimit,
});
const resourceRange = Type.Object({ min: Type.Integer(), max: Type.Integer(), step: Type.Integer() });
const planConfiguration = Type.Optional(Type.Union([Type.Literal("preset"), Type.Literal("custom")]));
export const BillingCustomQuoteSchema = Type.Object({
  basePlanTierId: tier,
  resources: CustomServerResourcesSchema,
  reference: Type.String(),
  priceCents: Type.Integer(), currency: Type.Literal("usd"),
  billingMode: Type.Literal("monthly"),
  monthlyCredits: Type.Null(),
  breakdown: Type.Object({ basePriceCents: Type.Integer(), cpuCents: Type.Integer(), memoryCents: Type.Integer(), diskCents: Type.Integer() }),
});
export const BillingPlansSchema = Type.Object({
  provider: Type.Optional(Type.Literal("oblien")),
  locale: Type.String(), annual: Type.Object({ enabled: Type.Boolean(), monthsFree: Type.Number() }),
  ui: Type.Record(Type.String(), Type.String()),
  computePricing: Type.Optional(Type.Object({
    tariffId: Type.String(), currency: Type.Literal("usd"),
    creditsPerDollar: Type.Number(), paygCapPercent: Type.Number(),
    usage: Type.Object({ activeVcpuHourCents: Type.Number(), reservedGiBHourCents: Type.Number(), retainedGiBMonthCents: Type.Number(), monthHours: Type.Number() }),
    network: Type.Object({ managedProxyGiBCents: Type.Number(), minimumTopupCents: Type.Number() }),
    retentionDays: Type.Number(), paygCheckoutAvailable: Type.Boolean(),
  })),
  custom: Type.Optional(Type.Object({
    resources: Type.Object({ cpuCores: resourceRange, memoryMb: resourceRange, diskGb: resourceRange }),
    extraMonthlyCents: Type.Object({ cpuCore: Type.Integer(), memoryGb: Type.Integer(), diskGb: Type.Integer() }),
  })),
  payg: Type.Optional(Type.Object({
    version: Type.Integer({ minimum: 1 }),
    creditPackagesCents: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
    tiers: Type.Array(Type.Object({
      id: Type.String({ pattern: "^tier_[1-9]\\d*$" }),
      level: Type.Integer({ minimum: 1 }),
      minimumFundingCents: Type.Integer({ minimum: 1 }),
      pool: Type.Object({
        cpuCores: Type.Integer({ minimum: 1 }), memoryMb: Type.Integer({ minimum: 1 }),
        diskGb: Type.Integer({ minimum: 1 }), servers: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false })),
  plans: Type.Array(Type.Object({
    id: tier, name: Type.String(), description: Type.String(), popular: Type.Boolean(),
    billingMode: Type.Optional(Type.Union([Type.Literal("monthly"), Type.Literal("metered")])),
    configuration: planConfiguration,
    offerReference: Type.Optional(Type.String()),
    price: Type.Object({ monthly: numberOrNull, annual: numberOrNull }),
    effectivePrice: Type.Object({ monthly: numberOrNull }), listPrice: Type.Object({ monthly: numberOrNull }),
    campaign: Type.Union([Type.Object({ id: Type.String(), percentOff: Type.Number(), durationMonths: numberOrNull, endsAt: Type.String() }), Type.Null()]),
    monthlyCredits: numberOrNull, annualCredits: Type.Optional(numberOrNull), limits: planLimits,
    resourceLimits: Type.Optional(namespaceResourceLimits),
    edge: Type.Optional(edgeLimits), features: Type.Array(Type.String()),
    featureKeys: Type.Optional(Type.Array(Type.String())),
    inheritedFrom: stringOrNull, support: Type.String(), contactSales: stringOrNull,
  })),
});
const changeOffer = Type.Object({ name: Type.String(), priceCents: Type.Integer({ minimum: 0 }), resourceLimits: Type.Optional(namespaceResourceLimits) });
const changeTerms = {
  id: Type.String(), direction: Type.Union([Type.Literal("upgrade"), Type.Literal("downgrade")]),
  current: changeOffer, next: changeOffer, effectiveAt: Type.String(),
  amountDueNow: Type.Integer({ minimum: 0 }), currency: Type.Literal("usd"),
};
export const BillingPlanChangeSchema = Type.Object({
  ...changeTerms,
  status: Type.Union(["queued", "dispatching", "payment_pending", "scheduled", "canceling", "reconciliation_required", "applied", "canceled", "expired", "failed"].map(value => Type.Literal(value))),
  paymentUrl: stringOrNull, paymentExpiresAt: stringOrNull,
  errorCode: stringOrNull, cancelable: Type.Boolean(), appliedAt: stringOrNull,
  serverUpdate: Type.Optional(Type.Union(["pending", "queued", "review_required", "not_required"].map(value => Type.Literal(value)))),
});
export const BillingPlanChangeQuoteSchema = Type.Object({
  ...changeTerms,
  expiresAt: Type.String(), interval: Type.Union([Type.Literal("monthly"), Type.Literal("annual")]),
  unusedTimeCredit: Type.Integer({ minimum: 0 }), remainingTimeCharge: Type.Integer({ minimum: 0 }),
  nextInvoiceAmount: numberOrNull,
  resize: Type.Union([CloudWorkspaceResizePreviewSchema, Type.Null()]),
});
export const BillingSubscriptionSchema = Type.Object({
  tier,
  billingMode: Type.Optional(Type.Union([Type.Literal("monthly"), Type.Literal("metered")])),
  configuration: planConfiguration,
  offerReference: Type.Optional(Type.String()),
  status: Type.Union(["active", "trialing", "past_due", "unpaid", "paused", "canceled"].map(value => Type.Literal(value))),
  interval: Type.Union([Type.Literal("monthly"), Type.Literal("annual")]),
  currentPeriod,
  cancelAtPeriodEnd: Type.Boolean(), canceledAt: stringOrNull,
  pendingChange: Type.Optional(Type.Union([BillingPlanChangeSchema, Type.Null()])),
});
export const BillingCheckoutStatusSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("subscription"), Type.Literal("topup")]),
  status: Type.Union(["open", "complete", "expired"].map((value) => Type.Literal(value))),
  paymentStatus: Type.Union(
    ["paid", "unpaid", "no_payment_required"].map((value) => Type.Literal(value)),
  ),
  fulfillmentStatus: Type.Union(
    ["pending", "completed", "partially_refunded", "refunded", "disputed", "expired", "failed", "superseded", "reversed"].map(
      (value) => Type.Literal(value),
    ),
  ),
  fulfilled: Type.Boolean(),
  creditsGranted: Type.Number(),
});
export const BillingPendingCheckoutSchema = Type.Object({
  id: Type.String(), checkoutId: stringOrNull,
  server: CloudWorkspaceSchema,
  kind: Type.Union([Type.Literal("subscription"), Type.Literal("topup")]),
  name: Type.String(), amountCents: Type.Integer({ minimum: 0 }), currency: Type.Literal("usd"),
  interval: Type.Union([Type.Literal("monthly"), Type.Literal("annual"), Type.Null()]),
  state: Type.Union((["open", "unconfirmed", "processing", "canceling", "unavailable"] as const).map(value => Type.Literal(value))),
  canResume: Type.Boolean(), canCancel: Type.Boolean(),
});
export const BillingPendingCheckoutsSchema = Type.Object({ items: Type.Array(BillingPendingCheckoutSchema) });
export const BillingCheckoutActionInputSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
  id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
export const BillingCheckoutActionResultSchema = Type.Object({
  status: Type.Union((["ready", "processing", "expired", "canceling"] as const).map(value => Type.Literal(value))),
  checkoutId: stringOrNull, checkoutUrl: stringOrNull,
});
export const BillingCreditAlertSchema = Type.Object({
  state: Type.Union(["ok", "low", "grace", "depleted", "unlimited", "disabled"].map(value => Type.Literal(value))),
  namespace: Type.String(), percent: numberOrNull, threshold: numberOrNull, thresholds: Type.Array(Type.Number()),
  remaining: numberOrNull, balance: numberOrNull, limit: numberOrNull,
});
export const BillingComputeSchema = Type.Object({
  billingMode: Type.Union([Type.Literal("monthly"), Type.Literal("payg")]),
  covered: Type.Boolean(), status: Type.String(), currentPeriod, autoRenew: Type.Boolean(),
  monthlyAmount: Type.Integer(), paygCapAmount: Type.Integer(),
  retention: Type.Object({ minimumDays: Type.Number(), automaticDeletion: Type.Literal(false), reviewAt: Type.String(),
    storagePerGiBMonth: Type.Number(), amountDue: Type.Number(), currency: Type.Literal("usd") }),
  network: Type.Object({
    service: Type.Literal("managed_proxy_transfer"), included: Type.Boolean(),
    purchasedBytes: Type.Number(), consumedBytes: Type.Number(), reservedBytes: Type.Number(),
    availableBytes: numberOrNull,
    unlimited: Type.Optional(Type.Boolean({ description: "Explicit provider benefit; null availability alone does not mean unlimited." })),
    status: Type.Optional(Type.Union((["active", "low", "grace", "blocked", "inactive"] as const).map(value => Type.Literal(value)))),
    includedBytes: Type.Optional(numberOrNull), includedAvailableBytes: Type.Optional(numberOrNull),
    purchasedAvailableBytes: Type.Optional(Type.Number()), periodConsumedBytes: Type.Optional(Type.Number()),
  }),
  savings: Type.Union([Type.Object({ currency: Type.Literal("usd"), baseline: Type.Literal("recorded_usage_at_saved_payg_rates"),
    usageBeforeCap: Type.Number(), capDiscount: Type.Number(), usageAfterCap: Type.Number(), usageCharged: Type.Number(),
    prepaidAmount: Type.Number(), monthlyDifference: Type.Number(), networkIncluded: Type.Literal(false), refundsIncluded: Type.Literal(false) }), Type.Null()]),
});
export const BillingStateSchema = Type.Object({
  compute: Type.Optional(Type.Union([BillingComputeSchema, Type.Null()])),
  workspace: Type.Optional(Type.Union([Type.Object({
    id: Type.String(), serverId: Type.Optional(Type.String()), name: Type.String(),
    provisioned: Type.Optional(Type.Boolean({ description: "A provider server is allocated. This is presentation state, not a billing entitlement." })),
  }), Type.Null()])),
  creditAlert: Type.Optional(Type.Union([BillingCreditAlertSchema, Type.Null()])),
  tier, status: Type.String(), currentPeriod,
  balance: Type.Object({ total: numberOrNull, quotaLimit: numberOrNull, quotaUsed: Type.Number(), quotaRemaining: numberOrNull, unlimited: Type.Optional(Type.Boolean()) }),
  plan: Type.Optional(Type.Union([BillingPlansSchema.properties.plans.items, Type.Null()])),
  subscription: Type.Optional(Type.Union([BillingSubscriptionSchema, Type.Null()])),
  complimentary: Type.Optional(Type.Union([Type.Object({ id: Type.String(), expiresAt: stringOrNull }), Type.Null()])),
  capabilities: Type.Optional(Type.Object({ portal: Type.Boolean(), cancellation: Type.Boolean(), resumption: Type.Optional(Type.Boolean()), subscriptionChange: Type.Boolean() })),
  monthlyCreditLimit: numberOrNull, overQuota: Type.Boolean(), buildTimeMinutes: numberOrNull,
  capacity: Type.Optional(Type.Partial(Type.Object({ routes: meter, workspaces: meter, vcpus: meter, ramMb: meter, diskGb: meter, bandwidthGb: meter, buildMinutes: meter, services: meter, projects: meter }))),
  maxServiceMachine: Type.Union([Type.Object({ tier: Type.String(), cpuCores: Type.Number(), memoryMb: Type.Number() }), Type.Null()]),
  buildMinutesResetAt: Type.String(),
  billing: Type.Object({ enabled: Type.Boolean(), status: Type.Union([Type.Literal("live"), Type.Literal("coming_soon"), Type.Literal("disabled")]) }),
  topups: Type.Object({ available: Type.Boolean(), status: Type.Union([Type.Literal("available"), Type.Literal("coming_soon"), Type.Literal("unavailable")]) }),
});
export const BillingCreditPackSchema = Type.Object({
  id: Type.String(), name: Type.String(), credits_milli: Type.Number(), price_cents: Type.Number(),
  sortOrder: Type.Number(), explains: stringOrNull,
});
export const BillingCreditStateSchema = Type.Pick(BillingStateSchema, [
  "workspace", "creditAlert", "compute", "tier", "currentPeriod", "balance", "billing", "topups",
]);
export const BillingCreditAlertsSchema = Type.Object({
  items: Type.Array(BillingCreditStateSchema),
  unavailableWorkspaceIds: Type.Array(Type.String()),
});
export const BillingUsageInputSchema = Type.Object({
  ...BillingScopeSchema.properties,
  from: Type.Optional(Type.String({ maxLength: 64 })), to: Type.Optional(Type.String({ maxLength: 64 })),
  groupBy: Type.Optional(Type.Union([Type.Literal("hour"), Type.Literal("day")])),
});
export const BillingPublicSchemas = {
  listPlans: { action: "read", input: Type.Object({ locale: Type.Optional(Type.String({ maxLength: 512 })) }), optionalInput: true, output: BillingPlansSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const BillingOperationSchemas = {
  ...ActionBillingOperationSchemas,
  quoteCustomPlan: { action: "read", input: CustomServerResourcesSchema, output: BillingCustomQuoteSchema },
  listCheckouts: { action: "read", input: BillingScopeSchema, optionalInput: true, output: BillingPendingCheckoutsSchema },
  resumeCheckout: { action: "write", input: BillingCheckoutActionInputSchema, output: BillingCheckoutActionResultSchema },
  cancelCheckout: { action: "admin", input: BillingCheckoutActionInputSchema, output: BillingCheckoutActionResultSchema },
  getCheckout: {
    action: "read",
    input: Type.Object(
      { ...BillingScopeSchema.properties, checkoutId: Type.String({ pattern: "^(?:cs_[A-Za-z0-9_]+|bco_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$", maxLength: 255 }) },
      { additionalProperties: false },
    ),
    output: BillingCheckoutStatusSchema,
  },
  getState: { action: "read", input: BillingScopeSchema, optionalInput: true, output: BillingStateSchema },
  getCreditAlerts: { action: "read", output: BillingCreditAlertsSchema },
  getResources: { action: "read", input: BillingScopeSchema, optionalInput: true, output: BillingResourcesSchema },
  getSubscription: { action: "read", input: BillingScopeSchema, optionalInput: true, output: Type.Object({ tier, status: Type.String(), currentPeriod, subscription: Type.Optional(Type.Union([BillingSubscriptionSchema, Type.Null()])) }) },
  createSubscription: { action: "write", input: CreateSubscriptionBody, output: Type.Object({ checkoutUrl: Type.String() }) },
  previewSubscriptionChange: { action: "write", input: PreviewSubscriptionChangeBody, output: BillingPlanChangeQuoteSchema },
  confirmSubscriptionChange: { action: "admin", input: ConfirmSubscriptionChangeBody, output: BillingPlanChangeSchema },
  getSubscriptionChange: { action: "read", input: SubscriptionChangeScopeSchema, output: BillingPlanChangeSchema },
  cancelSubscriptionChange: { action: "admin", input: SubscriptionChangeScopeSchema, output: BillingPlanChangeSchema },
  cancelSubscription: { action: "admin", input: BillingScopeSchema, optionalInput: true, output: Type.Object({ cancelAt: stringOrNull, subscription: BillingSubscriptionSchema }) },
  resumeSubscription: { action: "admin", input: BillingScopeSchema, optionalInput: true, output: Type.Object({ subscription: BillingSubscriptionSchema }) },
  createTopup: { action: "write", input: CreateTopupBody, output: Type.Object({ checkoutUrl: Type.String() }) },
  listTopupPacks: { action: "read", output: Type.Array(BillingCreditPackSchema) },
  // The hosted portal can cancel renewal, so it requires the same grant as cancel.
  createPortal: { action: "admin", input: BillingScopeSchema, optionalInput: true, output: Type.Object({ portalUrl: Type.String() }) },
  getUsage: { action: "read", input: BillingUsageInputSchema, optionalInput: true, output: Type.Object({
    from: Type.String(), to: Type.String(), groupBy: Type.Union([Type.Literal("hour"), Type.Literal("day")]),
    // Oblien's metering payload is forwarded without renaming its provider fields.
    usage: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  }) },
  listAllowanceDetail: { action: "read", input: BillingScopeSchema, optionalInput: true, output: Type.Object({ freeSubdomains: Type.Object({
    used: Type.Number(), limit: numberOrNull, remaining: numberOrNull, suffix: Type.String(),
    items: Type.Array(Type.Object({ domainId: Type.String(), hostname: Type.String(), projectId: stringOrNull, projectName: Type.String(), projectSlug: stringOrNull, serviceId: stringOrNull, createdAt: Type.String() })),
  }) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type BillingState = Static<typeof BillingStateSchema>;
export type BillingCreditState = Static<typeof BillingCreditStateSchema>;
export type BillingCreditAlerts = Static<typeof BillingCreditAlertsSchema>;
export type BillingResources = Static<typeof BillingResourcesSchema>;
export type BillingSubscription = Static<typeof BillingSubscriptionSchema>;
export type BillingPlanChange = Static<typeof BillingPlanChangeSchema>;
export type BillingPlanChangeQuote = Static<typeof BillingPlanChangeQuoteSchema>;
export type BillingCheckoutStatus = Static<typeof BillingCheckoutStatusSchema>;
export type BillingPendingCheckout = Static<typeof BillingPendingCheckoutSchema>;
export type BillingPendingCheckouts = Static<typeof BillingPendingCheckoutsSchema>;
export type BillingCheckoutActionInput = Static<typeof BillingCheckoutActionInputSchema>;
export type BillingCheckoutActionResult = Static<typeof BillingCheckoutActionResultSchema>;
export type BillingCreditPack = Static<typeof BillingCreditPackSchema>;
export type BillingPlans = Static<typeof BillingPlansSchema>;
export type BillingCustomQuote = Static<typeof BillingCustomQuoteSchema>;
export interface BillingOperations extends ScopedOperations<typeof BillingPublicSchemas>, ScopedOperations<typeof BillingOperationSchemas> {}

/** Older HTTP servers returned DB camelCase fields after catalog sync, and
 * catalog snake_case before it. Both represent the same public credit pack. */
export function normalizeBillingCreditPacks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(row => row && typeof row === "object" ? {
    id: row.id, name: row.name, credits_milli: row.credits_milli ?? row.creditsMilli,
    price_cents: row.price_cents ?? row.priceCents, sortOrder: row.sortOrder, explains: row.explains ?? null,
  } : row);
}
