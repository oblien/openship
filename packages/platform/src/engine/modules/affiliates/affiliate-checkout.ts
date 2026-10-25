import { AppError } from "@repo/contracts";
import { affiliateParticipantKey } from "./affiliate-provider";

/** Save authenticated identities with the checkout; never accept them from the buyer. */
export function affiliateCheckoutBinding(input: {
  enabled: boolean;
  namespace: string;
  userId: string;
  memberIds: string[];
  offer: { billingMode?: string; unitAmount: number };
  interval: "monthly" | "annual";
  affiliateCode?: string;
}) {
  const eligible =
    input.enabled &&
    input.offer.billingMode === "monthly" &&
    input.offer.unitAmount >= 1000 * (input.interval === "annual" ? 12 : 1);
  if (!eligible) {
    if (input.affiliateCode)
      throw new AppError(
        "Referral codes apply to eligible Cloud compute plans only",
        400,
        "AFFILIATE_INELIGIBLE",
      );
    return {};
  }
  const relatedKeys = [...new Set(input.memberIds)].map(affiliateParticipantKey);
  // Large teams can still check out normally, but must not omit a member from the self-referral check.
  if (relatedKeys.length > 100) {
    if (input.affiliateCode)
      throw new AppError(
        "Contact support to apply a referral to this workspace",
        409,
        "AFFILIATE_REVIEW_REQUIRED",
      );
    return {};
  }
  return {
    ...(input.affiliateCode ? { affiliateCode: input.affiliateCode } : {}),
    affiliateBuyer: {
      namespace: input.namespace,
      buyerKey: affiliateParticipantKey(input.userId),
      relatedKeys,
    },
  };
}
