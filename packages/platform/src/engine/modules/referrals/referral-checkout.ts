import { AppError } from "@repo/contracts";
import { referralParticipantKey } from "./referral-provider";

/** Normalize the published alias before creating a checkout or its idempotency record. */
export function resolveReferralCode(input: { referralCode?: string; affiliateCode?: string }) {
  if (input.referralCode && input.affiliateCode && input.referralCode !== input.affiliateCode)
    throw new AppError("Supply one referral code for this purchase", 400, "REFERRAL_CODE_CONFLICT");
  return input.referralCode ?? input.affiliateCode;
}

/** Save authenticated identities with the checkout; never accept them from the buyer. */
export function referralCheckoutBinding(input: {
  enabled: boolean;
  namespace: string;
  userId: string;
  memberIds: string[];
  offer: { billingMode?: string; unitAmount: number };
  interval: "monthly" | "annual";
  referralCode?: string;
}) {
  const eligible =
    input.enabled &&
    input.offer.billingMode === "monthly" &&
    input.offer.unitAmount >= 1000 * (input.interval === "annual" ? 12 : 1);
  if (!eligible) {
    if (input.referralCode)
      throw new AppError(
        "Referral codes apply to eligible Cloud compute plans only",
        400,
        "AFFILIATE_INELIGIBLE",
      );
    return {};
  }
  const relatedKeys = [...new Set(input.memberIds)].map(referralParticipantKey);
  // Large teams can still check out normally, but must not omit a member from the self-referral check.
  if (relatedKeys.length > 100) {
    if (input.referralCode)
      throw new AppError(
        "Contact support to apply a referral to this workspace",
        409,
        "AFFILIATE_REVIEW_REQUIRED",
      );
    return {};
  }
  return {
    ...(input.referralCode ? { affiliateCode: input.referralCode } : {}),
    affiliateBuyer: {
      namespace: input.namespace,
      buyerKey: referralParticipantKey(input.userId),
      relatedKeys,
    },
  };
}
