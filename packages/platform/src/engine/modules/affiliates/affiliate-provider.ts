import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  AffiliateOperationSchemas,
  AppError,
  parseInput,
  type AffiliateOperations,
  type AffiliateOverview,
} from "@repo/contracts";
import type { OblienBillingApi } from "../../lib/oblien-billing-api";

export const AFFILIATE_PARTICIPANT_PREFIX = "openship:affiliate:v1:";
export const affiliateParticipantKey = (userId: string) =>
  createHash("sha256").update(`${AFFILIATE_PARTICIPANT_PREFIX}${userId}`).digest("hex");
export function unavailableAffiliateOverview(): AffiliateOverview {
  return {
    available: false,
    program: { version: 1, policies: [] },
    member: null,
    summary: {
      currency: "usd",
      earned: 0,
      reversed: 0,
      credited: 0,
      available: 0,
      reserved: 0,
      paid: 0,
      referrals: 0,
      converted: 0,
    },
  };
}
const endpoints = {
  overview: "overview",
  enroll: "enroll",
  offers: "offers",
  createOffer: "offers",
  revokeOffer: "offers",
  referrals: "referrals",
  payments: "referrals",
  payouts: "payouts",
  requestPayout: "payouts",
  setPayoutDestination: "payout-destination",
  cancelPayout: "payouts",
} as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Provider is the financial authority. Identity is bound before projecting any records. */
export async function callAffiliateProvider<K extends keyof AffiliateOperations>(
  billing: Pick<OblienBillingApi, "affiliateRequest">,
  scope: { namespace: string; participantKey: string },
  dashboardUrl: string,
  operation: K,
  input: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<AffiliateOperations[K]>>> {
  const spec = AffiliateOperationSchemas[operation];
  const method = spec.action === "read" ? "GET" : "POST";
  const { id, ...rest } = input;
  const suffix =
    operation === "revokeOffer"
      ? `/${id}/revoke`
      : operation === "cancelPayout"
        ? `/${id}/cancel`
        : operation === "payments"
          ? `/${id}/payments`
          : "";
  const response = await billing.affiliateRequest(
    method,
    `/billing/affiliates/reseller/${endpoints[operation]}${suffix}`,
    method === "GET" ? { ...rest, ...scope } : { ...scope, input: rest },
  );
  if (
    !isRecord(response) ||
    response.success !== true ||
    !isRecord(response.scope) ||
    response.scope.namespace !== scope.namespace ||
    response.scope.participantKey !== scope.participantKey ||
    !isRecord(response.data)
  )
    throw new AppError(
      "Affiliate data could not be verified. Please retry.",
      502,
      "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
    );
  let data = response.data;
  const link = (offer: unknown) => {
    if (!isRecord(offer) || typeof offer.code !== "string") return offer;
    return { ...offer, url: new URL(`/r/${encodeURIComponent(offer.code)}`, dashboardUrl).href };
  };
  if (operation === "overview" || operation === "enroll") data = { ...data, available: true };
  if (operation === "createOffer" || operation === "revokeOffer")
    data = link(data) as Record<string, unknown>;
  if (operation === "offers" && Array.isArray(data.items))
    data = { ...data, items: data.items.map(link) };
  try {
    // Drop provider namespace, beneficiary, wallet and provider payment identifiers.
    return parseInput(spec.output, Value.Clean(spec.output, structuredClone(data))) as Awaited<
      ReturnType<AffiliateOperations[K]>
    >;
  } catch {
    throw new AppError(
      "Affiliate data could not be verified. Please retry.",
      502,
      "AFFILIATE_PROVIDER_RESPONSE_INVALID",
    );
  }
}
