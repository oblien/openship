import { Type, type Static } from "@sinclair/typebox";
import { PLAN_IDS, PLANS, PRICING } from "@repo/core";

export const BillingScopeSchema = Type.Object({
  workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Subscription-owned Cloud workspace ID, or organization for the existing project-owned Cloud mode. Omit only when billing scope is unambiguous." })),
}, { additionalProperties: false });
export type BillingScopeInput = Static<typeof BillingScopeSchema>;

/** Only a catalog choice reaches the server. Prices, credits and identity are server-owned. */
const purchasableTiers = PLAN_IDS.filter(id => (PLANS[id].price.monthly ?? 0) > 0);
const resourceRange = ({ min, max, step }: { min: number; max: number; step: number }) =>
  Type.Integer({ minimum: min, maximum: max, multipleOf: step });
export const CustomServerResourcesSchema = Type.Object({
  cpuCores: resourceRange(PRICING.custom.resources.cpuCores),
  memoryMb: resourceRange(PRICING.custom.resources.memoryMb),
  diskGb: resourceRange(PRICING.custom.resources.diskGb),
}, { additionalProperties: false });
export const CustomSubscriptionSelectionSchema = Type.Object({
  resources: CustomServerResourcesSchema,
  quoteReference: Type.String({ pattern: "^openship:custom:v1:[a-f0-9]{64}$" }),
}, { additionalProperties: false });
export type CustomSubscriptionSelection = Static<typeof CustomSubscriptionSelectionSchema>;

export const CreateSubscriptionBody = Type.Object(
  {
    ...BillingScopeSchema.properties,
    planTierId: Type.Union(purchasableTiers.map((id) => Type.Literal(id))),
    interval: Type.Union([Type.Literal("monthly"), Type.Literal("annual")]),
    custom: Type.Optional(CustomSubscriptionSelectionSchema),
    idempotencyKey: Type.Optional(
      Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    ),
  },
  { additionalProperties: false },
);
export type CreateSubscriptionInput = Static<typeof CreateSubscriptionBody>;
export const CreateTopupBody = Type.Object(
  {
    ...BillingScopeSchema.properties,
    packId: Type.String({ minLength: 1, maxLength: 64 }),
    idempotencyKey: Type.Optional(
      Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    ),
  },
  { additionalProperties: false },
);
export type CreateTopupInput = Static<typeof CreateTopupBody>;
