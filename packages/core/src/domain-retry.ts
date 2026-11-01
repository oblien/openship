/** Shared by the persisted retry query and the domain details read model. */
export const DOMAIN_VERIFY_GRACE_MS = 10 * 60_000;
export const DOMAIN_RETRY_DELAYS_MS: readonly number[] = [15, 30, 60, 120, 240, 360].map(
  (minutes) => minutes * 60_000,
);

export function domainRetryEligibleAt(
  domain: { createdAt: Date | string; lastCheckedAt: Date | string | null; verifyAttempts: number },
  graceMs = DOMAIN_VERIFY_GRACE_MS,
): Date {
  const firstCheck = new Date(domain.createdAt).getTime() + graceMs;
  if (!domain.lastCheckedAt || domain.verifyAttempts < 1) return new Date(firstCheck);
  const delay =
    DOMAIN_RETRY_DELAYS_MS[Math.min(domain.verifyAttempts, DOMAIN_RETRY_DELAYS_MS.length) - 1]!;
  return new Date(Math.max(firstCheck, new Date(domain.lastCheckedAt).getTime() + delay));
}
