import { z } from "zod";
import { Type } from "@sinclair/typebox";
import {
  AffiliateListInput,
  AffiliatePayoutSchema,
  AffiliatePayoutDestinationSchema,
  AffiliatePayoutDestinationSummarySchema,
  AppError,
  isRecord,
  parseInput,
} from "@repo/contracts";
import type { OblienBillingApi } from "../../lib/oblien-billing-api";
import { affiliateParticipantKey, callAffiliateProvider } from "./affiliate-provider";

const reviewFields = {
  operator: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(1).max(500),
};
const queueInput = Type.Object(
  {
    ...Type.Pick(AffiliateListInput, ["limit", "offset"]).properties,
    status: Type.Optional(AffiliatePayoutSchema.properties.status),
  },
  { additionalProperties: false },
);
const nullableText = Type.Union([Type.String(), Type.Null()]);
const queueOutput = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          ...AffiliatePayoutSchema.properties,
          participantKey: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          paymentReference: nullableText,
          reviewedBy: nullableText,
          reviewReason: nullableText,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

function operatorData(result: unknown, scope: { namespace: string; participantKey?: string }) {
  if (
    !isRecord(result) ||
    result.success !== true ||
    !isRecord(result.scope) ||
    result.scope.namespace !== scope.namespace ||
    (scope.participantKey !== undefined && result.scope.participantKey !== scope.participantKey)
  )
    throw new AppError(
      "Affiliate response scope could not be verified",
      502,
      "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
    );
  return result.data;
}

/** Trusted staff queue over the provider ledger. Never part of tenant-facing operations. */
export async function readAffiliatePayoutQueue(
  raw: unknown,
  namespace: string,
  billing: Pick<OblienBillingApi, "affiliateRequest">,
) {
  const input = parseInput(queueInput, raw);
  const scope = { namespace };
  const result = await billing.affiliateRequest(
    "GET",
    "/billing/affiliates/reseller/payouts/queue",
    {
      ...scope,
      status: input.status ?? "pending",
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    },
  );
  const data = operatorData(result, scope);
  try {
    return parseInput(queueOutput, data);
  } catch {
    throw new AppError(
      "Affiliate queue could not be verified",
      502,
      "AFFILIATE_PROVIDER_RESPONSE_INVALID",
    );
  }
}
export const affiliateOperatorCommand = z.discriminatedUnion("command", [
  z.object({ command: z.literal("show"), offset: z.number().int().min(0).default(0) }).strict(),
  z
    .object({
      command: z.literal("configure"),
      minimumCents: z.number().int().min(100).max(100000000),
      enabled: z.boolean(),
      ...reviewFields,
    })
    .strict(),
  z.object({ command: z.literal("destination"), payoutId: z.uuid(), ...reviewFields }).strict(),
  z
    .object({ command: z.enum(["approve", "reject"]), payoutId: z.uuid(), ...reviewFields })
    .strict(),
  z
    .object({
      command: z.literal("paid"),
      payoutId: z.uuid(),
      paymentReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/),
      ...reviewFields,
    })
    .strict(),
]);
/** Trusted process only. There is deliberately no tenant-facing approval route. */
export async function runAffiliateOperator(
  raw: unknown,
  target: { userId?: string; participantKey?: string; namespace: string; dashboardUrl: string },
  billing: Pick<OblienBillingApi, "affiliateRequest">,
) {
  const input = affiliateOperatorCommand.parse(raw);
  if (Boolean(target.userId) === Boolean(target.participantKey))
    throw new AppError(
      "Choose exactly one account email or participant key",
      400,
      "AFFILIATE_OPERATOR_TARGET_REQUIRED",
    );
  const scope = {
    namespace: target.namespace,
    participantKey: target.userId
      ? affiliateParticipantKey(target.userId)
      : z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(target.participantKey),
  };
  if (input.command === "show") {
    const [overview, payouts] = await Promise.all([
      callAffiliateProvider(billing, scope, target.dashboardUrl, "overview"),
      callAffiliateProvider(billing, scope, target.dashboardUrl, "payouts", {
        limit: 100,
        offset: input.offset,
      }),
    ]);
    return { overview, payouts };
  }
  if (input.command === "destination") {
    const result = await billing.affiliateRequest(
      "POST",
      `/billing/affiliates/reseller/payouts/${input.payoutId}/destination`,
      {
        ...scope,
        input: { operator: input.operator, reason: input.reason },
      },
    );
    const data = operatorData(result, scope);
    if (data === null) return null;
    const parsed = parseInput(
      Type.Object(
        {
          revision: AffiliatePayoutDestinationSummarySchema.properties.revision,
          destination: AffiliatePayoutDestinationSchema,
        },
        { additionalProperties: false },
      ),
      data,
    );
    return parsed;
  }
  const path = input.command === "configure" ? "participant" : `payouts/${input.payoutId}/review`;
  const body =
    input.command === "configure"
      ? {
          payoutMinimumCents: input.minimumCents,
          enabled: input.enabled,
          operator: input.operator,
          reason: input.reason,
        }
      : {
          status:
            input.command === "approve"
              ? "processing"
              : input.command === "reject"
                ? "rejected"
                : "paid",
          operator: input.operator,
          reason: input.reason,
          ...(input.command === "paid" ? { paymentReference: input.paymentReference } : {}),
        };
  const result = await billing.affiliateRequest("POST", `/billing/affiliates/reseller/${path}`, {
    ...scope,
    input: body,
  });
  return operatorData(result, scope);
}
