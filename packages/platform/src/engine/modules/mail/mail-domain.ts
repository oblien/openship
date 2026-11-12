/** One domain contract for API input and names recovered from a mail database. */
export const MAIL_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

export function validateMailDomain(domain: string): void {
  const normalized = domain.trim().toLowerCase();
  if (!MAIL_DOMAIN_RE.test(normalized) || normalized.length > 255)
    throw new Error(`Invalid domain: ${domain}`);
}
