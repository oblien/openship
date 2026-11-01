import { ValidationError, isValidCustomHostname, normalizeCustomHostname } from "@repo/core";

/**
 * Shape gate for a CLIENT-AUTHORED custom hostname — the one place the write
 * routes agree on what a custom domain may look like.
 *
 * `isValidCustomHostname` (@repo/core) is the predicate; POST /domains and the
 * service routing patch already called it. The project write paths did not, so
 * `publicEndpoints: [{ customDomain: "localhost", ... }]` was a 200 that minted a
 * pending domain row and then a `server_name localhost;` vhost on the shared edge
 * — nginx's own DOMAIN_RE (`^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$`) accepts
 * single labels and IPv4 literals, so `localhost` / `127.0.0.1` / `single` sailed
 * through it. Shapes with a path, port or scheme left a dead domain row plus a
 * deploy warning instead. #342
 *
 * WRITE PATHS ONLY. Never call this while normalizing STORED rows: a project that
 * already holds a bad hostname must keep reading, deploying and being editable —
 * the job here is to stop new ones landing, not to brick the existing ones.
 */

/** A row that can carry a hostname: the scalar pair, plus its multi-route endpoints. */
export interface CustomDomainCarrier {
  domainType?: string | null;
  customDomain?: string | null;
  publicEndpoints?: Array<{ domainType?: string | null; customDomain?: string | null } | null> | null;
}

/**
 * Throws unless `raw` is a plausible public hostname.
 *
 * Absent/blank passes: an empty custom domain is dropped by normalization (and
 * reported by preflight as "cannot be empty"), so failing it here would reject
 * the routing card's switched-to-custom-but-not-yet-typed state.
 *
 * Normalizes first, with the SAME normalizer the siblings use, so a pasted
 * `https://example.com/` is accepted and stored as `example.com` on every path
 * instead of being valid on two of them and a 400 on the third.
 */
export function assertValidCustomDomain(raw: string | null | undefined): void {
  if (!raw?.trim()) return;
  const hostname = normalizeCustomHostname(raw);
  if (!isValidCustomHostname(hostname)) {
    throw new ValidationError(`"${hostname || raw.trim()}" is not a valid custom domain.`);
  }
}

/**
 * Every hostname the given rows would route on, raw + normalized.
 *
 * ONE walk, shared by the collector and the assert below so they can't disagree
 * about which fields count. Only `domainType: "custom"` rows are yielded — that is
 * the only case a write stores the value (`normalizeStoredPublicEndpoint`,
 * `normalizeRoutingFields`), so a stray `customDomain` left on a free row is
 * ignored rather than made a 400. Blanks are skipped (see assertValidCustomDomain).
 */
function* customHostnameEntries(
  carriers: Array<CustomDomainCarrier | null | undefined>,
): Generator<{ raw: string; hostname: string }> {
  for (const carrier of carriers) {
    if (!carrier) continue;
    for (const row of [carrier, ...(carrier.publicEndpoints ?? [])]) {
      if (row?.domainType !== "custom" || !row.customDomain?.trim()) continue;
      yield { raw: row.customDomain, hostname: normalizeCustomHostname(row.customDomain) };
    }
  }
}

/**
 * The custom hostnames the given rows carry, normalized. Exported so a caller can
 * build the `known` set out of its STORED rows with the identical rule — "what this
 * row routes on" answered once, whether the row is submitted or already persisted.
 */
export function customHostnamesOf(
  carriers: Array<CustomDomainCarrier | null | undefined>,
): string[] {
  return [...customHostnameEntries(carriers)].map((entry) => entry.hostname).filter(Boolean);
}

/**
 * Assert every custom hostname the given rows carry.
 *
 * `opts.known` exempts hostnames the project ALREADY has, and callers that can
 * cheaply supply them should: a submitted endpoint list is AUTHORITATIVE, so every
 * save echoes the whole set back, and a project holding a bad hostname from before
 * this gate — or a `localhost` vhost adopted by a server migration — would
 * otherwise be unable to save any domain edit, including the one that removes it.
 * Refusing to INTRODUCE a bad hostname is the point; refusing to let go of one
 * isn't. Same rule as the free-endpoint gate next door (`assertFreeEndpointsAllowed`
 * only fires for net-new free routes).
 */
export function assertValidCustomDomains(
  carriers: Array<CustomDomainCarrier | null | undefined>,
  opts?: { known?: Iterable<string> },
): void {
  const known = new Set(
    [...(opts?.known ?? [])].map((hostname) => normalizeCustomHostname(hostname)).filter(Boolean),
  );
  for (const { raw, hostname } of customHostnameEntries(carriers)) {
    if (known.has(hostname)) continue;
    assertValidCustomDomain(raw);
  }
}
