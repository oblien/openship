/**
 * Domain CRUD for the mail admin panel.
 *
 * Wraps `vmail.domain` operations. The install creates the first domain
 * automatically (the one the operator entered in the wizard) - this module
 * lets them add more, list them with mailbox/alias counts, and remove them.
 *
 * Counters: `vmail.domain.mailboxes` and `vmail.domain.aliases` are
 * application-managed counters in iRedMail (not triggers). We keep them in
 * sync inside create/update/delete operations by recounting from the
 * authoritative `mailbox` / `forwardings` tables.
 */

import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";
import { provisionDomainDkim, genSecret } from "../mail.service";
import { execute, queryOne, queryRows, q, qInt } from "./psql-runner";
import { safeErrorMessage } from "@repo/core";
import {
  buildDomainDnsRecords,
  recordDomainDns,
  deleteDomainDns,
} from "./domain-dns.service";

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

export interface DomainRow {
  domain: string;
  description: string;
  mailboxes: number;
  aliases: number;
  /** Domain-wide max (0 = unlimited). */
  maxMailboxes: number;
  maxAliases: number;
  /** Default per-mailbox quota in MB (0 = no per-domain cap). */
  defaultQuotaMB: number;
  active: boolean;
  createdAt: string;
}

export interface CreateDomainInput {
  domain: string;
  description?: string;
  maxMailboxes?: number;
  maxAliases?: number;
  defaultQuotaMB?: number;
}

export interface UpdateDomainInput {
  description?: string;
  maxMailboxes?: number;
  maxAliases?: number;
  defaultQuotaMB?: number;
  active?: boolean;
}

const SELECT_COLUMNS = `
  domain,
  description,
  mailboxes,
  aliases,
  mailboxes AS "maxMailboxes",
  aliases AS "maxAliases",
  maxquota AS "defaultQuotaMB",
  (active = 1) AS active,
  created::text AS "createdAt"
`;

/**
 * Note on counter columns: iRedMail overloads `vmail.domain.mailboxes` and
 * `.aliases` - they're used BOTH as the upper-limit cap AND as a live count.
 * iRedAdmin updates them on every create/delete. We follow that convention.
 * The "live count" is what we want to surface in the UI as `mailboxes` /
 * `aliases`, so we return them under those names. The `max*` aliases in
 * the SELECT above are pre-existing iRedAdmin terminology - we keep both
 * shapes so client-side code can read either intent without ambiguity.
 *
 * For now the UI doesn't differentiate "current count" vs "max" because
 * iRedMail conflates them. If we later split them apart we'd add an
 * `openship_meta` table on the mail VPS (NOT on openship's DB).
 */

export function validateDomain(domain: string): void {
  const d = domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(d) || d.length > 255) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

export async function listDomains(serverId: string): Promise<DomainRow[]> {
  return queryRows<DomainRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM domain ORDER BY domain`,
  );
}

export async function getDomain(
  serverId: string,
  domain: string,
): Promise<DomainRow | null> {
  validateDomain(domain);
  return queryOne<DomainRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM domain WHERE domain = ${q(domain.toLowerCase())}`,
  );
}

export async function createDomain(
  serverId: string,
  input: CreateDomainInput,
): Promise<{ row: DomainRow; dnsWarning?: string }> {
  validateDomain(input.domain);
  const domain = input.domain.toLowerCase();

  // Duplicate check is implicit (PRIMARY KEY) but we surface a friendlier
  // error than psql's `duplicate key value violates unique constraint`.
  const existing = await getDomain(serverId, domain);
  if (existing) {
    throw new DomainExistsError(domain);
  }

  await execute(
    serverId,
    `INSERT INTO domain (
        domain, description,
        mailboxes, aliases, maxquota,
        active, created, modified
      ) VALUES (
        ${q(domain)},
        ${q(input.description ?? "")},
        ${qInt(input.maxMailboxes ?? 0)},
        ${qInt(input.maxAliases ?? 0)},
        ${qInt(input.defaultQuotaMB ?? 0)},
        1, NOW(), NOW()
      )`,
  );

  // After the SQL insert succeeds, provision DKIM for the new domain
  // (amavis keypair + 50-user config splice + reload), then record the
  // MX/SPF/DKIM/DMARC bundle the operator needs to publish at their DNS
  // provider. Postfix already accepts mail for the new domain - these
  // records are about external senders finding the MX target and passing
  // SPF/DKIM/DMARC alignment.
  //
  // The `mail.<installDomain>` MX target is the only hostname with an SSL
  // cert + iRedMail config, so every additional domain shares it.
  //
  // DKIM provisioning is best-effort: if it fails, we still record the
  // MX/SPF/DMARC banner so the operator can publish those, and the
  // dnsWarning toast tells them what to fix.
  // Auto-create the postmaster mailbox for the new domain. iRedMail's
  // installer creates postmaster for the primary install; we mirror that
  // behavior so every added domain has a working SMTP-Auth identity out
  // of the box - needed for DKIM/SPF alignment when sending AS the new
  // domain, and read by the welcome test-email flow after the operator
  // acks the DNS banner.
  //
  // Dynamic import: mailboxes.service imports `recountDomain` from us,
  // so a static reverse-import would form a load-time cycle. Same
  // pattern used in `deleteDomain` below.
  // Track the postmaster-creation outcome separately from `dnsWarning` so
  // the operator gets a precise message instead of a generic 535 at
  // welcome-send time. If postmaster creation failed AND a postmaster
  // mailbox already exists in vmail.mailbox from a prior attempt (with
  // an unknown hash), the test-email flow would later authenticate with
  // a plaintext we never saved against a hash we never set - surface
  // that as a fatal/visible warning here so the operator can rotate the
  // password (or delete and re-add the domain) before they hit the
  // welcome modal.
  let postmasterPassword: string | undefined;
  let postmasterWarning: string | undefined;
  try {
    postmasterPassword = genSecret(18);
    const { createMailbox } = await import("./mailboxes.service");
    await createMailbox(serverId, {
      localPart: "postmaster",
      domain,
      password: postmasterPassword,
      name: "Postmaster",
    });
  } catch (err) {
    const message = safeErrorMessage(err);
    console.warn(
      `createDomain: postmaster mailbox creation failed for ${domain}: ${message}`,
    );
    postmasterPassword = undefined;
    postmasterWarning =
      `Postmaster mailbox auto-creation failed for ${domain} (${message}). ` +
      `Test-send AS ${domain} will not work until you create or rotate ` +
      `postmaster@${domain} from the Mailboxes tab.`;
  }

  let dnsWarning: string | undefined;
  try {
    const { installDomain, dkimValue, dkimError, ipv4, ipv6, relayInclude } =
      await sshManager.withExecutor(serverId, async (exec) => {
        const state = await readState(exec);
        const installDomain = state?.domain ?? null;
        // A domain added while the relay routes ALL domains (scope="all", or a
        // legacy relay with no scope) inherits the SES SPF include so it can
        // send through the relay immediately. "selected"-scope relays don't
        // auto-enroll new domains — the operator adds them in the Sending tab.
        const relay = state?.outboundRelay;
        const relayInclude = !!(relay?.enabled && relay.scope !== "selected");
        // Pull the same IPs step 11 detected for the primary install so
        // additional domains publish identical SPF shape: `mx ip4:… ip6:… -all`.
        // Falling back to mx-only SPF (no IPs) still passes, but the explicit
        // IPs make receivers skip an MX→A lookup and stay aligned during
        // brief MX-resolution hiccups.
        const records = (state?.dnsRecords ?? null) as Record<
          string,
          { value?: string } | undefined
        > | null;
        const ipv4 = typeof records?.a?.value === "string" ? records.a.value : null;
        const ipv6 =
          typeof records?.aaaa?.value === "string" ? records.aaaa.value : null;
        if (!installDomain) {
          return {
            installDomain: null,
            dkimValue: undefined,
            dkimError: undefined,
            ipv4,
            ipv6,
            relayInclude,
          };
        }
        try {
          const dkimValue = await provisionDomainDkim(exec, domain);
          return { installDomain, dkimValue, dkimError: undefined, ipv4, ipv6, relayInclude };
        } catch (err) {
          return {
            installDomain,
            dkimValue: undefined,
            dkimError: safeErrorMessage(err),
            ipv4,
            ipv6,
            relayInclude,
          };
        }
      });
    if (!installDomain) {
      dnsWarning =
        "Mail state file is missing the primary install domain - DNS records for the new domain were not generated. Re-run the mail install or contact support.";
    } else {
      const records = buildDomainDnsRecords(
        installDomain,
        domain,
        dkimValue,
        ipv4,
        ipv6,
        { sesInclude: relayInclude },
      );
      await recordDomainDns(serverId, domain, records, postmasterPassword);
      if (dkimError) {
        dnsWarning = `Domain added, but DKIM provisioning failed: ${dkimError}. MX/SPF/DMARC records are still in the banner - DKIM can be added later.`;
      }
    }
  } catch (err) {
    const message = safeErrorMessage(err);
    console.warn(
      `createDomain: DNS record persistence failed for ${domain}: ${message}`,
    );
    dnsWarning = `DNS record persistence failed for ${domain}: ${message}`;
  }

  const row = await getDomain(serverId, domain);
  if (!row) throw new Error(`createDomain: row not found after INSERT for ${domain}`);
  // Merge the postmaster-creation warning into the dnsWarning so the
  // operator sees both classes of issue at the same surface (the toast /
  // banner that follows domain add) rather than discovering the auth
  // problem later via a 535 at welcome-send time.
  const finalWarning = [dnsWarning, postmasterWarning].filter(Boolean).join(" ");
  return { row, dnsWarning: finalWarning || undefined };
}

export async function updateDomain(
  serverId: string,
  domain: string,
  patch: UpdateDomainInput,
): Promise<DomainRow> {
  validateDomain(domain);
  const d = domain.toLowerCase();

  const sets: string[] = ["modified = NOW()"];
  if (patch.description !== undefined) {
    sets.push(`description = ${q(patch.description)}`);
  }
  if (patch.maxMailboxes !== undefined) {
    sets.push(`mailboxes = ${qInt(patch.maxMailboxes)}`);
  }
  if (patch.maxAliases !== undefined) {
    sets.push(`aliases = ${qInt(patch.maxAliases)}`);
  }
  if (patch.defaultQuotaMB !== undefined) {
    sets.push(`maxquota = ${qInt(patch.defaultQuotaMB)}`);
  }
  if (patch.active !== undefined) {
    sets.push(`active = ${patch.active ? 1 : 0}`);
  }

  if (sets.length === 1) {
    // Nothing to update - return current row without an UPDATE.
    const row = await getDomain(serverId, d);
    if (!row) throw new DomainNotFoundError(d);
    return row;
  }

  await execute(
    serverId,
    `UPDATE domain SET ${sets.join(", ")} WHERE domain = ${q(d)}`,
  );

  const row = await getDomain(serverId, d);
  if (!row) throw new DomainNotFoundError(d);
  return row;
}

/**
 * Count active mailboxes + aliases that would be orphaned by deleting this
 * domain. Returns 0 when the domain is safe to drop.
 */
export async function countDomainDependents(
  serverId: string,
  domain: string,
): Promise<{ mailboxes: number; aliases: number }> {
  validateDomain(domain);
  const d = domain.toLowerCase();
  const row = await queryOne<{ mailboxes: number; aliases: number }>(
    serverId,
    `SELECT
       (SELECT COUNT(*)::int FROM mailbox WHERE domain = ${q(d)}) AS mailboxes,
       (SELECT COUNT(*)::int FROM forwardings WHERE domain = ${q(d)} AND is_alias = 1) AS aliases`,
  );
  return row ?? { mailboxes: 0, aliases: 0 };
}

/**
 * Delete a domain. Without `cascade`, refuses when mailboxes/aliases still
 * exist (caller should empty those first). With `cascade=true`, wipes every
 * mailbox (DB rows + Maildirs on disk) and every alias under the domain
 * before removing the domain row + `domain_admins` mappings.
 */
export async function deleteDomain(
  serverId: string,
  domain: string,
  options: { cascade?: boolean } = {},
): Promise<void> {
  validateDomain(domain);
  const d = domain.toLowerCase();

  const deps = await countDomainDependents(serverId, d);
  if ((deps.mailboxes > 0 || deps.aliases > 0) && !options.cascade) {
    throw new DomainHasDependentsError(d, deps);
  }

  if (options.cascade && (deps.mailboxes > 0 || deps.aliases > 0)) {
    // Cascade: hard-delete every mailbox (rows + Maildirs) and every alias
    // forwarding row for the domain. We lazy-import to avoid a circular
    // import with mailboxes.service (which imports recountDomain from us).
    const { listMailboxes, hardDeleteMailbox } = await import("./mailboxes.service");
    const mailboxes = await listMailboxes(serverId, d);
    for (const m of mailboxes) {
      // Postmaster of the install domain can't be hard-deleted, but the
      // install domain itself can't be dropped while it has a mailbox
      // anyway. For additional domains, postmaster is a regular mailbox
      // - we don't carry the install-domain guard here so let the lower
      // function decide.
      try {
        await hardDeleteMailbox(serverId, m.username);
      } catch (err) {
        // Surface the first failure: leaving half-deleted state is worse
        // than aborting the cascade and letting the operator retry.
        throw new Error(
          `cascade delete: failed to remove mailbox ${m.username}: ${safeErrorMessage(err)}`,
        );
      }
    }
    // Wipe the remaining alias forwarding rows. Mailboxes own a
    // self-forwarding row that `hardDeleteMailbox` already removed; the
    // statement below cleans up everything else (is_alias=1, plus any
    // dangling forwards that pointed into the domain).
    await execute(
      serverId,
      `DELETE FROM forwardings WHERE domain = ${q(d)}`,
    );
  }

  await execute(
    serverId,
    `DELETE FROM domain_admins WHERE domain = ${q(d)};
     DELETE FROM domain WHERE domain = ${q(d)};`,
  );

  // Best-effort: drop any persisted DNS-pending banner state so the
  // dashboard doesn't keep nagging about a domain that no longer exists.
  await deleteDomainDns(serverId, d).catch(() => {});
}

/**
 * Recalculate `vmail.domain.mailboxes` / `.aliases` from the source tables.
 * Called by mailbox/alias services after mutations so the counters stay
 * accurate even when iRedMail's own scripts touch the tables outside our
 * UI.
 */
export async function recountDomain(
  serverId: string,
  domain: string,
): Promise<void> {
  validateDomain(domain);
  const d = domain.toLowerCase();
  await execute(
    serverId,
    `UPDATE domain SET
       mailboxes = (SELECT COUNT(*) FROM mailbox WHERE domain = ${q(d)} AND active = 1),
       aliases   = (SELECT COUNT(*) FROM forwardings WHERE domain = ${q(d)} AND is_alias = 1 AND active = 1),
       modified  = NOW()
     WHERE domain = ${q(d)}`,
  );
}

// ─── Typed errors ────────────────────────────────────────────────────────────

export class DomainExistsError extends Error {
  constructor(public domain: string) {
    super(`Domain already exists: ${domain}`);
  }
}

export class DomainNotFoundError extends Error {
  constructor(public domain: string) {
    super(`Domain not found: ${domain}`);
  }
}

export class DomainHasDependentsError extends Error {
  constructor(
    public domain: string,
    public dependents: { mailboxes: number; aliases: number },
  ) {
    super(
      `Domain ${domain} still has ${dependents.mailboxes} mailbox(es) and ${dependents.aliases} alias(es). Remove them first.`,
    );
  }
}
