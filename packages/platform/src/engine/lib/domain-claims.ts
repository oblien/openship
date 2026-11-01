/**
 * "May this project ROUTE a hostname it does not own?"
 *
 * The generic question the general routing paths should be asking.
 *
 * `domain.owner_type` is already a general concept — `project` (the default),
 * `webhook`, `mail` — so the data model has always allowed a row that belongs to
 * something other than a project. What the code lacked was a matching question. Both
 * general paths (`lib/routing-domains.ts` and `modules/domains/domain.service.ts`)
 * instead hardcoded a call to the MAIL predicate, each with its own copy of the
 * mail-specific reasoning, in the middle of logic that is otherwise subsystem-blind.
 *
 * That is the smell this file removes. A general path now asks one general question,
 * and each subsystem that owns hostnames answers for itself. When `webhook`-owned rows
 * need the same treatment it becomes an entry below, not a third `if` in a third
 * general path.
 *
 * WHAT "TRUE" MEANS, and why it is not just tidiness: the caller registers the vhost
 * and creates NO domain row. `domain.project_id` cascades on project delete, so
 * stamping the routing project onto a foreign-owned row would make deleting that
 * project delete the owner's record — for mail, that is the mail host's only
 * certificate-renewal row, and the failure surfaces as silent TLS expiry ~90 days
 * later with nothing to restore it (#566).
 */

import { repos, type Domain } from "@repo/db";
import type { ProjectRoutingClaim } from "@repo/contracts";

import { mailHostRoutableByProject } from "./mail-host-claim";

/**
 * One subsystem's answer for the hostnames it owns.
 *
 * Contract: NEVER throw. These are consulted on the way to a conflict error, and a
 * failed lookup must leave the caller's existing refusal in place rather than replace
 * it with a 500. Each implementation is responsible for that.
 */
type ForeignHostClaim = (
  hostname: string,
  projectId: string,
  row?: Domain | null,
) => Promise<boolean>;

/**
 * Every subsystem that can hand a project routing rights over a hostname it does not
 * own. One entry today; the point is that adding the second one touches this list and
 * nothing else.
 */
const FOREIGN_HOST_CLAIMS: ForeignHostClaim[] = [mailHostRoutableByProject];

/**
 * True when some subsystem grants `projectId` the right to route `hostname` while
 * owning no row for it.
 *
 * Call this BEFORE the cross-project ownership refusal and whether or not a row
 * exists: a claim can legitimately apply to a hostname with no row at all (mail's
 * `recordMailCertDomain` is best-effort), and inside an `if (row)` branch the caller
 * would fall through and MINT a project-owned row for the very hostname the claim
 * exists to protect.
 *
 * @param row The already-fetched domain row for this hostname, when the caller has
 *   one — passed through so a claim can inspect it without a second query.
 */
export async function routableWithoutOwnership(
  hostname: string,
  projectId: string,
  row?: Domain | null,
): Promise<boolean> {
  for (const claim of FOREIGN_HOST_CLAIMS) {
    if (await claim(hostname, projectId, row)) return true;
  }
  return false;
}

/** Read only the public status of authorized foreign hostnames. Never adopt their
 * rows: deleting this project must not delete the owning subsystem's certificates. */
export async function readProjectRoutingClaims(
  projectId: string,
  hostnames: Iterable<string>,
): Promise<ProjectRoutingClaim[]> {
  const claims = await Promise.all(
    [...new Set([...hostnames].map((hostname) => hostname.toLowerCase()))].map(async (hostname) => {
      const row = await repos.domain.findByHostname(hostname);
      if (
        row?.projectId === projectId ||
        !(await routableWithoutOwnership(hostname, projectId, row))
      )
        return null;
      return {
        hostname,
        ownerType: row?.ownerType ?? null,
        verified: row?.verified ?? null,
        status: row?.status ?? null,
        sslStatus: row?.sslStatus ?? null,
        sslExpiresAt: row?.sslExpiresAt?.toISOString() ?? null,
        manualSsl: row?.manualSsl ?? false,
      } satisfies ProjectRoutingClaim;
    }),
  );
  return claims.filter((claim) => claim !== null);
}
