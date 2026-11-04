import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const cents = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const id = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
export const AffiliateCodeSchema = Type.String({ pattern: "^AF-[A-Z0-9][A-Z0-9-]{5,59}$" });
export const AffiliateListInput = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
    offerId: Type.Optional(id),
  },
  { additionalProperties: false },
);
const policy = Type.Object({
  id,
  name: Type.String(),
  commissionBps: Type.Integer({ minimum: 1, maximum: 10000 }),
  durationMonths: Type.Integer({ minimum: 1, maximum: 36 }),
  minimumMonthlyCents: cents,
  payoutMinimumCents: cents,
  planId: nullableString,
});
const payoutMethod = Type.Union([
  Type.Literal("paypal"),
  Type.Literal("bank_transfer"),
  Type.Literal("wise"),
  Type.Literal("payoneer"),
]);
const recipientName = Type.String({ minLength: 2, maxLength: 120 });
const email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
});
export const AffiliatePayoutDestinationSchema = Type.Union([
  Type.Object(
    {
      method: Type.Literal("paypal"),
      accountName: recipientName,
      identifier: Type.Union([
        email,
        Type.String({ pattern: "^https://(www\\.)?paypal\\.me/[A-Za-z0-9_-]{3,64}/?$" }),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      method: Type.Union([Type.Literal("wise"), Type.Literal("payoneer")]),
      accountName: recipientName,
      identifier: email,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      method: Type.Literal("bank_transfer"),
      accountName: recipientName,
      country: Type.String({ pattern: "^[A-Z]{2}$" }),
      bankName: Type.String({ minLength: 2, maxLength: 120 }),
      accountNumber: Type.String({ pattern: "^[A-Za-z0-9 ]{4,50}$" }),
      bankCode: Type.String({ pattern: "^[A-Za-z0-9 -]{3,40}$" }),
      beneficiaryAddress: Type.String({ minLength: 5, maxLength: 300 }),
      bankAddress: Type.Optional(Type.String({ maxLength: 300 })),
    },
    { additionalProperties: false },
  ),
]);
export const AffiliatePayoutDestinationSummarySchema = Type.Object(
  {
    revision: id,
    method: payoutMethod,
    accountName: recipientName,
    label: Type.String(),
    country: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const nullableDestination = Type.Union([AffiliatePayoutDestinationSummarySchema, Type.Null()]);
export type AffiliatePayoutDestination = Static<typeof AffiliatePayoutDestinationSchema>;
export type AffiliatePayoutDestinationSummary = Static<
  typeof AffiliatePayoutDestinationSummarySchema
>;
export const AffiliateOverviewSchema = Type.Object({
  available: Type.Boolean(),
  program: Type.Object({ version: Type.Literal(1), policies: Type.Array(policy) }),
  member: Type.Union([
    Type.Object({
      enabled: Type.Boolean(),
      payoutMinimumCents: cents,
      payoutDestination: Type.Optional(nullableDestination),
    }),
    Type.Null(),
  ]),
  summary: Type.Object({
    currency: Type.Literal("usd"),
    earned: cents,
    reversed: cents,
    credited: cents,
    available: cents,
    reserved: cents,
    paid: cents,
    referrals: cents,
    converted: cents,
  }),
});
const affiliatePlanId = Type.String({ pattern: "^vm:[0-9.]+:[0-9]+:[0-9]+$" });
export const AffiliatePlanSelectionSchema = Type.Object(
  {
    planId: affiliatePlanId,
    intervals: Type.Array(Type.Union([Type.Literal("monthly"), Type.Literal("annual")]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
const eligiblePlans = Type.Union([
  Type.Array(AffiliatePlanSelectionSchema, { minItems: 1, maxItems: 100 }),
  Type.Null(),
]);
export type AffiliatePlanSelection = Static<typeof AffiliatePlanSelectionSchema>;
export const AffiliateOfferSchema = Type.Object({
  id,
  code: AffiliateCodeSchema,
  url: Type.String(),
  name: Type.String(),
  productId: Type.Literal("workspace_vm"),
  planId: nullableString,
  commissionBps: Type.Integer({ minimum: 1, maximum: 10000 }),
  discountBps: Type.Integer({ minimum: 0, maximum: 10000 }),
  eligiblePlans: Type.Optional(eligiblePlans),
  durationMonths: Type.Integer(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("revoked"),
    Type.Literal("expired"),
    Type.Literal("disabled"),
  ]),
  createdAt: Type.String(),
  expiresAt: nullableString,
  revokedAt: nullableString,
});
export const AffiliateReferralSchema = Type.Object({
  id,
  offerId: id,
  customer: nullableString,
  productId: Type.Literal("workspace_vm"),
  planId: nullableString,
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("active"),
    Type.Literal("expired"),
    Type.Literal("canceled"),
    Type.Literal("canceling"),
    Type.Literal("past_due"),
    Type.Literal("unpaid"),
    Type.Literal("paused"),
    Type.Literal("trialing"),
  ]),
  paidThrough: nullableString,
  autoRenew: Type.Boolean(),
  nextRenewalAt: nullableString,
  joinedAt: Type.String(),
  rewardsUntil: nullableString,
  lastPaymentAt: nullableString,
  paidCycles: cents,
  earned: cents,
  currency: Type.Literal("usd"),
});
export const AffiliatePaymentSchema = Type.Object({
  id: Type.String(),
  currency: Type.Literal("usd"),
  subtotal: cents,
  discount: cents,
  paid: cents,
  commission: cents,
  reversed: cents,
  credited: cents,
  periodStart: nullableString,
  periodEnd: nullableString,
  status: Type.Union([
    Type.Literal("reversed"),
    Type.Literal("partially_reversed"),
    Type.Literal("pending"),
    Type.Literal("credited"),
  ]),
});
export const AffiliatePayoutSchema = Type.Object({
  destination: Type.Optional(nullableDestination),
  id,
  amountCents: cents,
  currency: Type.Literal("usd"),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("processing"),
    Type.Literal("paid"),
    Type.Literal("canceled"),
    Type.Literal("rejected"),
  ]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const page = <
  T extends
    | typeof AffiliateOfferSchema
    | typeof AffiliateReferralSchema
    | typeof AffiliatePaymentSchema
    | typeof AffiliatePayoutSchema,
>(
  item: T,
) => Type.Object({ total: cents, items: Type.Array(item) });
const idempotencyKey = Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
export const CreateAffiliateOfferSchema = Type.Object(
  {
    policyId: id,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    planId: Type.Optional(
      Type.Union([Type.String({ pattern: "^vm:[0-9.]+:[0-9]+:[0-9]+$" }), Type.Null()]),
    ),
    discountBps: Type.Integer({ minimum: 0, maximum: 10000 }),
    eligiblePlans: Type.Optional(eligiblePlans),
    expiresAt: Type.Optional(
      Type.Union([
        Type.String({
          maxLength: 40,
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+(Z|[+-][0-9]{2}:[0-9]{2})$",
        }),
        Type.Null(),
      ]),
    ),
    idempotencyKey,
  },
  { additionalProperties: false },
);
const target = Type.Object({ id }, { additionalProperties: false });
export const AffiliateOperationSchemas = {
  overview: { action: "read", output: AffiliateOverviewSchema },
  enroll: { action: "write", output: AffiliateOverviewSchema },
  offers: {
    action: "read",
    input: AffiliateListInput,
    optionalInput: true,
    output: page(AffiliateOfferSchema),
  },
  createOffer: { action: "write", input: CreateAffiliateOfferSchema, output: AffiliateOfferSchema },
  revokeOffer: { action: "write", input: target, output: AffiliateOfferSchema },
  referrals: {
    action: "read",
    input: AffiliateListInput,
    optionalInput: true,
    output: page(AffiliateReferralSchema),
  },
  payments: {
    action: "read",
    input: Type.Object({ ...AffiliateListInput.properties, id }, { additionalProperties: false }),
    output: page(AffiliatePaymentSchema),
  },
  payouts: {
    action: "read",
    input: AffiliateListInput,
    optionalInput: true,
    output: page(AffiliatePayoutSchema),
  },
  setPayoutDestination: {
    action: "write",
    input: Type.Object(
      { destination: AffiliatePayoutDestinationSchema },
      { additionalProperties: false },
    ),
    output: AffiliatePayoutDestinationSummarySchema,
  },
  requestPayout: {
    action: "write",
    input: Type.Object(
      {
        amountCents: Type.Integer({ minimum: 100, maximum: 100000000 }),
        idempotencyKey,
        destinationRevision: Type.Optional(id),
      },
      { additionalProperties: false },
    ),
    output: AffiliatePayoutSchema,
  },
  cancelPayout: { action: "write", input: target, output: AffiliatePayoutSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface AffiliateOperations extends ScopedOperations<typeof AffiliateOperationSchemas> {}
export type AffiliateOverview = Static<typeof AffiliateOverviewSchema>;
export type AffiliateOffer = Static<typeof AffiliateOfferSchema>;
export type AffiliateReferral = Static<typeof AffiliateReferralSchema>;
export type AffiliatePayment = Static<typeof AffiliatePaymentSchema>;
export type AffiliatePayout = Static<typeof AffiliatePayoutSchema>;

/** Personal account operations. No affiliate/recipient/namespace may be supplied by a client. */
export const AffiliateRoutes = {
  overview: { method: "GET", path: "/affiliates" },
  enroll: { method: "POST", path: "/affiliates/enroll" },
  offers: { method: "GET", path: "/affiliates/offers" },
  createOffer: { method: "POST", path: "/affiliates/offers" },
  revokeOffer: { method: "POST", path: "/affiliates/offers/revoke" },
  referrals: { method: "GET", path: "/affiliates/referrals" },
  payments: { method: "GET", path: "/affiliates/referrals/payments" },
  payouts: { method: "GET", path: "/affiliates/payouts" },
  setPayoutDestination: { method: "POST", path: "/affiliates/payout-destination" },
  requestPayout: { method: "POST", path: "/affiliates/payouts" },
  cancelPayout: { method: "POST", path: "/affiliates/payouts/cancel" },
} as const;

export const AffiliatePublicOfferSchema = Type.Object(
  {
    code: AffiliateCodeSchema,
    name: Type.String(),
    productId: Type.Literal("workspace_vm"),
    planId: nullableString,
    discountBps: Type.Integer({ minimum: 0, maximum: 10000 }),
    eligiblePlans: Type.Optional(eligiblePlans),
    durationMonths: Type.Integer({ minimum: 1, maximum: 36 }),
    expiresAt: nullableString,
    minimumMonthlyCents: cents,
  },
  { additionalProperties: false },
);
export type AffiliatePublicOffer = Static<typeof AffiliatePublicOfferSchema>;
