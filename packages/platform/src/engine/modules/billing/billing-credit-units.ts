/**
 * Credit-unit boundary — THE single place openship's internal credit unit
 * meets Oblien's. Pure (no imports) so it's trivially unit-testable and can't
 * drag env/db/SDK side effects into a test.
 *
 * Openship stores credits in MILLI (1000 milli = 1 credit): that's what
 * `PLANS[].monthlyCredits`, `credit_pack.credits_milli`, and the dashboard's
 * `formatCredits(÷1000)` all speak. Oblien's `quotaLimit` / `quota_used` are
 * in whole Oblien credits, capped at 10,000,000. Every write divides by 1000;
 * every read multiplies by 1000 — right here, nowhere else. (1 openship credit
 * ≡ 1 Oblien credit; tune the tier numbers to Oblien's real rate before launch.)
 */

export const MILLI_PER_CREDIT = 1000;
export const OBLIEN_QUOTA_MAX_CREDITS = 10_000_000;
export const OBLIEN_QUOTA_MAX_MILLI = OBLIEN_QUOTA_MAX_CREDITS * MILLI_PER_CREDIT;

/**
 * Convert an openship milli-credit amount to the whole-Oblien-credit value the
 * quota API expects. Throws on a non-positive / non-finite amount or one that
 * would exceed Oblien's hard ceiling — a misconfigured tier/pack must fail
 * loudly at the call site, not silently clamp. Callers that legitimately
 * accumulate (topups) pre-clamp in milli via `OBLIEN_QUOTA_MAX_MILLI`.
 */
export function toOblienCredits(milli: number): number {
  const credits = milli / MILLI_PER_CREDIT;
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error(
      `Invalid quota: ${milli} milli-credits resolves to ${credits} Oblien credits`,
    );
  }
  if (credits > OBLIEN_QUOTA_MAX_CREDITS) {
    throw new Error(
      `Quota ${credits} exceeds Oblien's ${OBLIEN_QUOTA_MAX_CREDITS}-credit ceiling (from ${milli} milli-credits)`,
    );
  }
  return credits;
}

/** Convert a whole-Oblien-credit value back to openship milli-credits. */
export function fromOblienCredits(credits: number): number {
  return credits * MILLI_PER_CREDIT;
}
