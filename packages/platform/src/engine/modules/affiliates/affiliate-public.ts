import {
  AffiliateCodeSchema,
  AffiliatePublicOfferSchema,
  AppError,
  isRecord,
  parseInput,
} from "@repo/contracts";
import { cloudRuntimeTarget, env } from "../../config/env";
import { reportCaughtError } from "@repo/core/diagnostics";
import { getOblienBillingApi } from "../../lib/oblien-client";

export async function readAffiliateOffer(code: string) {
  parseInput(AffiliateCodeSchema, code);
  if (!env.CLOUD_MODE) {
    // Like the public Cloud plan catalog, desktop reads commercial terms from
    // the configured Cloud API without forwarding any local credential.
    try {
      const response = await fetch(new URL(`/api/referrals/${code}`, cloudRuntimeTarget.api), {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new AppError(
          "This referral offer is unavailable",
          response.status === 404 ? 404 : 503,
          "AFFILIATE_UNAVAILABLE",
        );
      const result = await response.json();
      const offer = parseInput(
        AffiliatePublicOfferSchema,
        isRecord(result) ? result.data : undefined,
      );
      if (offer.code !== code)
        throw new AppError(
          "This referral offer could not be verified",
          502,
          "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
        );
      return offer;
    } catch (error) {
      reportCaughtError(error, "platform/affiliates/public-offer");
      if (error instanceof AppError) throw error;
      throw new AppError(
        "This referral offer could not be verified. Please retry.",
        503,
        "AFFILIATE_UNAVAILABLE",
      );
    }
  }
  if (!env.AFFILIATES_ENABLED)
    throw new AppError("This referral offer is unavailable", 404, "AFFILIATE_UNAVAILABLE");
  const result = await getOblienBillingApi().affiliateRequest(
    "GET",
    `/billing/affiliates/reseller/codes/${code}`,
    { namespace: env.OBLIEN_AFFILIATE_NAMESPACE },
  );
  if (
    !isRecord(result) ||
    result.success !== true ||
    !isRecord(result.scope) ||
    result.scope.namespace !== env.OBLIEN_AFFILIATE_NAMESPACE
  )
    throw new AppError(
      "This referral offer could not be verified",
      502,
      "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
    );
  const offer = parseInput(AffiliatePublicOfferSchema, result.offer);
  if (offer.code !== code)
    throw new AppError(
      "This referral offer could not be verified",
      502,
      "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
    );
  return offer;
}
