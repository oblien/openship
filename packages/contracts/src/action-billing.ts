import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const units = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const purchaseId = Type.String({ pattern: "^acredit_[A-Za-z0-9_-]+$", maxLength: 128 });
export const ActionCreditPurchaseSchema = Type.Object(
  {
    id: purchaseId,
    priceCents: Type.Integer({ minimum: 1 }),
    fundedUnits: units,
    status: Type.String(),
    createdAt: Type.String(),
    checkedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ActionBudgetSchema = Type.Object(
  {
    currency: Type.Literal("usd"),
    unitsPerDollar: Type.Integer({ minimum: 1 }),
    purchasesAvailable: Type.Boolean(),
    balance: Type.Object(
      {
        fundedUnits: units,
        spentUnits: units,
        reservedUnits: units,
        availableUnits: units,
        balanceUnits: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    pricing: Type.Object(
      {
        version: Type.Integer({ minimum: 1 }),
        transferGiBPerDollar: Type.Integer({ minimum: 1 }),
        depositsCents: Type.Array(Type.Integer({ minimum: 1 })),
        runners: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              cpuCores: Type.Integer({ minimum: 1 }),
              memoryMb: Type.Integer({ minimum: 1 }),
              diskGb: Type.Integer({ minimum: 1 }),
              microUsdPerMinute: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    purchases: Type.Array(ActionCreditPurchaseSchema),
  },
  { additionalProperties: false },
);

const purchaseInput = Type.Object({ purchaseId }, { additionalProperties: false });
const checkoutResult = Type.Object(
  {
    purchaseId,
    checkoutUrl: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** These belong to billing permissions, never to workflow/job grants. */
export const ActionBillingOperationSchemas = {
  getActionsBudget: { action: "read", output: ActionBudgetSchema },
  getActionsPurchase: { action: "read", input: purchaseInput, output: ActionCreditPurchaseSchema },
  createActionsCheckout: {
    action: "write",
    input: Type.Object(
      {
        amountCents: Type.Integer({ minimum: 1, maximum: 10000 }),
        idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" }),
      },
      { additionalProperties: false },
    ),
    output: checkoutResult,
  },
  resumeActionsCheckout: { action: "write", input: purchaseInput, output: checkoutResult },
} as const satisfies Record<string, ResourceOperationSchema>;

export type ActionBudget = Static<typeof ActionBudgetSchema>;
export type ActionCreditPurchase = Static<typeof ActionCreditPurchaseSchema>;
