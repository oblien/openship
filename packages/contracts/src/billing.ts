import { Type, type Static } from "@sinclair/typebox";
import { PLAN_IDS, RESOURCE_TIER_ORDER, WORKLOAD_TYPES } from "@repo/core";
import { CreateSubscriptionBody, CreateTopupBody } from "./billing-inputs";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

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
  computeMinutesPerMonth: numberOrNull, buildMinutesPerMonth: numberOrNull,
  freeSubdomains: numberOrNull, customDomains: numberOrNull, seats: numberOrNull,
});
export const BillingPlansSchema = Type.Object({
  provider: Type.Optional(Type.Literal("oblien")),
  locale: Type.String(), annual: Type.Object({ enabled: Type.Boolean(), monthsFree: Type.Number() }),
  ui: Type.Record(Type.String(), Type.String()),
  plans: Type.Array(Type.Object({
    id: tier, name: Type.String(), description: Type.String(), popular: Type.Boolean(),
    price: Type.Object({ monthly: numberOrNull, annual: numberOrNull }),
    effectivePrice: Type.Object({ monthly: numberOrNull }), listPrice: Type.Object({ monthly: numberOrNull }),
    campaign: Type.Union([Type.Object({ id: Type.String(), percentOff: Type.Number(), durationMonths: numberOrNull, endsAt: Type.String() }), Type.Null()]),
    monthlyCredits: numberOrNull, annualCredits: Type.Optional(numberOrNull), limits: planLimits,
    edge: Type.Optional(edgeLimits), features: Type.Array(Type.String()),
    inheritedFrom: stringOrNull, support: Type.String(), contactSales: stringOrNull,
  })),
});
export const BillingSubscriptionSchema = Type.Object({
  tier,
  status: Type.Union(["active", "trialing", "past_due", "unpaid", "paused", "canceled"].map(value => Type.Literal(value))),
  interval: Type.Union([Type.Literal("monthly"), Type.Literal("annual")]),
  currentPeriod,
  cancelAtPeriodEnd: Type.Boolean(), canceledAt: stringOrNull,
});
export const BillingStateSchema = Type.Object({
  tier, status: Type.String(), currentPeriod,
  balance: Type.Object({ total: numberOrNull, quotaLimit: numberOrNull, quotaUsed: Type.Number(), quotaRemaining: numberOrNull, unlimited: Type.Optional(Type.Boolean()) }),
  plan: Type.Optional(Type.Union([BillingPlansSchema.properties.plans.items, Type.Null()])),
  subscription: Type.Optional(Type.Union([BillingSubscriptionSchema, Type.Null()])),
  capabilities: Type.Optional(Type.Object({ portal: Type.Boolean(), cancellation: Type.Boolean(), resumption: Type.Optional(Type.Boolean()), subscriptionChange: Type.Boolean() })),
  monthlyCreditLimit: numberOrNull, overQuota: Type.Boolean(), buildTimeMinutes: Type.Number(),
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
export const BillingUsageInputSchema = Type.Object({
  from: Type.Optional(Type.String({ maxLength: 64 })), to: Type.Optional(Type.String({ maxLength: 64 })),
  groupBy: Type.Optional(Type.Union([Type.Literal("hour"), Type.Literal("day")])),
});
export const BillingPublicSchemas = {
  listPlans: { action: "read", input: Type.Object({ locale: Type.Optional(Type.String({ maxLength: 512 })) }), optionalInput: true, output: BillingPlansSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const BillingOperationSchemas = {
  getState: { action: "read", output: BillingStateSchema },
  getResources: { action: "read", output: BillingResourcesSchema },
  getSubscription: { action: "read", output: Type.Object({ tier, status: Type.String(), currentPeriod, subscription: Type.Optional(Type.Union([BillingSubscriptionSchema, Type.Null()])) }) },
  createSubscription: { action: "write", input: CreateSubscriptionBody, output: Type.Object({ checkoutUrl: Type.String() }) },
  cancelSubscription: { action: "admin", output: Type.Object({ cancelAt: stringOrNull, subscription: BillingSubscriptionSchema }) },
  resumeSubscription: { action: "admin", output: Type.Object({ subscription: BillingSubscriptionSchema }) },
  createTopup: { action: "write", input: CreateTopupBody, output: Type.Object({ checkoutUrl: Type.String() }) },
  listTopupPacks: { action: "read", output: Type.Array(BillingCreditPackSchema) },
  // The hosted portal can cancel renewal, so it requires the same grant as cancel.
  createPortal: { action: "admin", output: Type.Object({ portalUrl: Type.String() }) },
  getUsage: { action: "read", input: BillingUsageInputSchema, optionalInput: true, output: Type.Object({
    from: Type.String(), to: Type.String(), groupBy: Type.Union([Type.Literal("hour"), Type.Literal("day")]),
    // Oblien's metering payload is forwarded without renaming its provider fields.
    usage: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  }) },
  listAllowanceDetail: { action: "read", output: Type.Object({ freeSubdomains: Type.Object({
    used: Type.Number(), limit: numberOrNull, remaining: numberOrNull, suffix: Type.String(),
    items: Type.Array(Type.Object({ domainId: Type.String(), hostname: Type.String(), projectId: stringOrNull, projectName: Type.String(), projectSlug: stringOrNull, serviceId: stringOrNull, createdAt: Type.String() })),
  }) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type BillingState = Static<typeof BillingStateSchema>;
export type BillingResources = Static<typeof BillingResourcesSchema>;
export type BillingSubscription = Static<typeof BillingSubscriptionSchema>;
export type BillingCreditPack = Static<typeof BillingCreditPackSchema>;
export type BillingPlans = Static<typeof BillingPlansSchema>;
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
