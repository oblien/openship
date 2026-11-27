import { validateMailDomain } from "../mail-domain";
import { execute, q } from "./psql-runner";
import { ownedDomain } from "./tenant-domains";

/**
 * Recalculate `vmail.domain.mailboxes` / `.aliases` from the source tables.
 * Called by mailbox/alias services after mutations so the counters stay
 * accurate even when iRedMail's own scripts touch the tables outside our
 * UI.
 */
export async function recountDomain(
  serverId: string,
  domain: string,
  namespace?: string,
): Promise<void> {
  validateMailDomain(domain);
  const d = domain.toLowerCase();
  await execute(
    serverId,
    `UPDATE domain SET
       mailboxes = (SELECT COUNT(*) FROM mailbox WHERE domain = ${q(d)} AND active = 1),
       aliases   = (SELECT COUNT(*) FROM forwardings WHERE domain = ${q(d)} AND is_alias = 1 AND active = 1),
       modified  = NOW()
     WHERE domain = ${q(d)}${ownedDomain(namespace)}`,
  );
}
