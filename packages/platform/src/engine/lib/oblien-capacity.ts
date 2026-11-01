import { z } from "zod";

// USD cents on tariffs; USD dollars on recorded savings and retained storage.
// Keep these units at the provider boundary instead of treating them as credits.
const amount = z.number().finite().nonnegative();
const cents = amount.int();
const date = z.string().refine(value => Number.isFinite(Date.parse(value)));
export const computeBillingModeSchema = z.enum(["monthly", "payg"]);
export const oblienCapacityPoolSchema = z.object({
  vcpus: z.number().finite().positive(),
  memoryMb: z.number().int().positive(),
  diskGb: z.number().int().positive(),
  workspaces: z.number().int().positive(),
});
export const oblienCapacityTariffSchema = z.object({
  id: z.string().min(1), currency: z.literal("usd"), creditsPerDollar: amount.positive(),
  monthly: z.object({ vcpuCents: cents, memoryGiBCents: cents, diskGiBCents: cents, minimumCents: cents }),
  paygCapPercent: amount.positive(),
  usage: z.object({ activeVcpuHourCents: amount, reservedGiBHourCents: amount, retainedGiBMonthCents: amount, monthHours: amount.positive() }),
  network: z.object({ managedProxyGiBCents: amount, minimumTopupCents: cents }),
  requiredMeterVersion: z.number().int().positive(),
  terms: z.object({
    cpuClass: z.literal("shared"), networkIncluded: z.literal(false), backupsIncluded: z.literal(false),
    autoRenewDefault: z.literal(false), calendar: z.literal("subscription_anniversary"),
    expiryGraceHours: amount, retainedAfterExpiryDays: amount, automaticDeletion: z.literal(false),
    retentionBilling: z.literal("storage_until_deleted"),
  }),
});
export const oblienCapacityCatalogSchema = z.object({
  resellerSubscriptionIntervals: z.array(z.enum(["monthly", "yearly"])).optional(),
  success: z.literal(true), currency: z.literal("usd"), tariffId: z.string().min(1),
  billingModes: z.array(computeBillingModeSchema), tariff: oblienCapacityTariffSchema,
  paymentSources: z.object({ payg: z.array(z.enum(["wallet", "stripe"])), monthly: z.array(z.enum(["wallet", "stripe"])) }),
  presets: z.array(z.object({
    id: z.string().min(1), capacity: oblienCapacityPoolSchema, monthlyAmount: cents, paygCapAmount: cents,
  })),
}).refine(value => value.tariffId === value.tariff.id, "Capacity tariff identity mismatch");

export const oblienCapacitySavingsSchema = z.object({
  currency: z.literal("usd"), baseline: z.literal("recorded_usage_at_saved_payg_rates"),
  usageBeforeCap: amount, capDiscount: amount, usageAfterCap: amount, usageCharged: amount,
  prepaidAmount: amount, monthlyDifference: z.number().finite(),
  networkIncluded: z.literal(false), refundsIncluded: z.literal(false),
});

// Transfer benefits can change without changing the saved compute tariff.
// Keep the provider's counters and state; an absent limit never grants unlimited
// transfer, and transfer availability never grants compute coverage.
const oblienManagedTransferSchema = z.object({
  service: z.literal("managed_proxy_transfer"), included: z.boolean(),
  purchasedBytes: amount, consumedBytes: amount, reservedBytes: amount,
  availableBytes: amount.nullable(),
  unlimited: z.boolean().optional(),
  status: z.enum(["active", "low", "grace", "blocked", "inactive"]).optional(),
  includedBytes: amount.nullable().optional(),
  includedAvailableBytes: amount.nullable().optional(),
  purchasedAvailableBytes: amount.optional(),
  periodConsumedBytes: amount.optional(),
}).superRefine((value, ctx) => {
  for (const field of ["availableBytes", "includedBytes", "includedAvailableBytes"] as const) {
    if (value[field] === null && value.unlimited !== true)
      ctx.addIssue({ code: "custom", path: [field], message: "Null transfer limits require explicit unlimited coverage" });
  }
});

export const oblienNamespaceCapacitySchema = z.object({
  id: z.string().min(1), namespace: z.string().min(1), billingMode: computeBillingModeSchema,
  status: z.enum(["active", "expired", "revoked", "payment_required", "storage_payment_required", "pending"]),
  provider: z.enum(["wallet", "stripe"]), capacity: oblienCapacityPoolSchema,
  tariffId: z.string().min(1), currency: z.literal("usd"), monthlyAmount: cents, paygCapAmount: cents,
  periodStart: date, periodEnd: date, autoRenew: z.boolean(), computeCovered: z.boolean(),
  retention: z.object({
    minimumDays: amount, automaticDeletion: z.literal(false), reviewAt: date,
    storagePerGiBMonth: amount, amountDue: amount, currency: z.literal("usd"),
  }),
  pendingChange: z.object({
    id: z.string().min(1), billingMode: computeBillingModeSchema, capacity: oblienCapacityPoolSchema,
    monthlyAmount: cents, effectiveAt: date,
  }).nullable(),
  savings: oblienCapacitySavingsSchema.nullable(),
  network: oblienManagedTransferSchema,
});

export type OblienCapacityCatalog = z.infer<typeof oblienCapacityCatalogSchema>;
export type OblienNamespaceCapacity = z.infer<typeof oblienNamespaceCapacitySchema>;
