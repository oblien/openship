/**
 * Alias / forward / catch-all CRUD for the mail admin panel.
 *
 * An "alias" here is a row in `vmail.forwardings` with `is_alias = 1` -
 * distinct from a mailbox's own self-forwarding row (`is_forwarding = 1`,
 * owned by mailboxes.service.ts). Postfix's virtual_alias_maps / catchall_maps
 * read `forwardings` directly via live SQL lookup maps - no reload needed,
 * a row is effective the instant it commits.
 *
 * Two shapes share this table:
 *   - Per-address alias: address = "local@domain" - forwards ONE address to
 *     another (a local mailbox or an external address).
 *   - Catch-all: address = the BARE domain (no @). catchall_maps.cf's query
 *     is `WHERE forwardings.address = domain.domain`, so a bare-domain
 *     address IS the catch-all by construction - there's no separate flag.
 *     Postfix takes the first match, so only one catch-all per domain makes
 *     sense; createAlias replaces any existing one atomically.
 */

import { queryRows, queryOne, execute, transaction, q, qInt } from "@repo/platform/engine/modules/mail/admin/psql-runner";
import { recountDomain } from "@repo/platform/engine/modules/mail/admin/domain-counts";
import { lockTenantDomainSql, ownedDomain } from "@repo/platform/engine/modules/mail/admin/tenant-domains";
import { validateMailDomain as validateDomain } from "@repo/platform/engine/modules/mail/mail-domain";

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const LOCAL_PART_RE = /^[a-z0-9._+-]+$/;

const SELECT_COLUMNS = `
  id,
  address,
  forwarding,
  domain,
  dest_domain AS "destDomain",
  (address = domain) AS "isCatchAll",
  (active = 1) AS active
`;

export interface AliasRow {
  id: number;
  address: string;
  forwarding: string;
  domain: string;
  destDomain: string;
  isCatchAll: boolean;
  active: boolean;
}

export interface CreateAliasInput {
  domain: string;
  /** Ignored when isCatchAll is true. */
  localPart?: string;
  isCatchAll: boolean;
  destination: string;
}

function validateEmail(email: string): void {
  if (!EMAIL_RE.test(email) || email.length > 255) {
    throw new Error(`Invalid email: ${email}`);
  }
}

/** Trim + lowercase an address, then validate it. Returns the normalized form. */
function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 255) {
    throw new Error(`Invalid email: ${email}`);
  }
  return e;
}

function validateLocalPart(local: string): void {
  if (!LOCAL_PART_RE.test(local) || local.length === 0 || local.length > 64) {
    throw new Error(`Invalid local-part: ${local}`);
  }
}

export async function listAliases(
  serverId: string,
  domain: string,
  namespace?: string,
): Promise<AliasRow[]> {
  validateDomain(domain);
  return queryRows<AliasRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM forwardings
       WHERE domain = ${q(domain.toLowerCase())} AND is_alias = 1${ownedDomain(namespace)}
       ORDER BY (address = domain) DESC, address`,
  );
}

export async function getAlias(serverId: string, id: number, namespace?: string): Promise<AliasRow | null> {
  return queryOne<AliasRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM forwardings WHERE id = ${qInt(id)} AND is_alias = 1${ownedDomain(namespace)}`,
  );
}

/**
 * Create a per-address alias or a domain catch-all.
 *
 * Guards, in order:
 *   1. destination must be a valid email address.
 *   2. per-address: local-part must be valid; catch-all ignores localPart.
 *   3. the resulting address must not already be a real mailbox - creating
 *      an alias over a mailbox's own address would silently redirect that
 *      mailbox's mail (postfix's virtual_alias_maps is checked before
 *      virtual_mailbox_maps for a given address, so the alias would win).
 *   4. catch-all: any existing catch-all row for the domain is replaced
 *      (delete-then-insert in one transaction), so there's only ever one.
 */
export async function createAlias(
  serverId: string,
  input: CreateAliasInput,
  namespace?: string,
): Promise<AliasRow> {
  const domain = input.domain.trim().toLowerCase();
  validateDomain(domain);
  const destination = normalizeEmail(input.destination);
  const destDomain = destination.split("@")[1]!;

  const address = input.isCatchAll
    ? domain
    : (() => {
        const local = (input.localPart ?? "").trim().toLowerCase();
        validateLocalPart(local);
        const addr = `${local}@${domain}`;
        validateEmail(addr);
        return addr;
      })();

  // Guard 3: address must not collide with a real mailbox. Catch-all
  // addresses are bare domains and can never match a mailbox username
  // (always a full email), so this only applies to per-address aliases.
  if (!input.isCatchAll) {
    const mailboxHit = await queryOne<{ username: string }>(
      serverId,
      `SELECT username FROM mailbox WHERE username = ${q(address)}${ownedDomain(namespace)}`,
    );
    if (mailboxHit) {
      throw new AliasConflictsWithMailboxError(address);
    }
  }

  const statements: string[] = [];
  if (namespace !== undefined) {
    for (const name of new Set([domain, destDomain])) statements.push(lockTenantDomainSql(name, namespace));
  }
  if (input.isCatchAll) {
    statements.push(`DELETE FROM forwardings WHERE domain = ${q(domain)} AND address = ${q(domain)} AND is_alias = 1${ownedDomain(namespace)}`);
  } else {
    // Friendlier than letting the (address, forwarding) unique index fire -
    // matches the duplicate pre-check convention in mailboxes.service.ts.
    // Different DESTINATIONS for the same source address are allowed
    // (fan-out); only the exact pair is a duplicate.
    const existing = await queryOne<{ id: number }>(
      serverId,
      `SELECT id FROM forwardings WHERE address = ${q(address)} AND forwarding = ${q(destination)}${ownedDomain(namespace)}`,
    );
    if (existing) {
      throw new AliasExistsError(address, destination);
    }
  }
  const insert = `INSERT INTO forwardings (address, forwarding, domain, dest_domain, is_maillist, is_list, is_forwarding, is_alias, active)
    VALUES (${q(address)}, ${q(destination)}, ${q(domain)}, ${q(destDomain)}, 0, 0, 0, 1, 1)`;
  if (statements.length) await transaction(serverId, [...statements, insert]);
  else await execute(serverId, insert);

  await recountDomain(serverId, domain, namespace);

  const row = await queryOne<AliasRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM forwardings
       WHERE address = ${q(address)} AND forwarding = ${q(destination)} AND is_alias = 1${ownedDomain(namespace)}`,
  );
  if (!row) {
    throw new Error("Alias was created but could not be re-read.");
  }
  return row;
}

export async function updateAliasActive(
  serverId: string,
  id: number,
  active: boolean,
  namespace?: string,
): Promise<AliasRow> {
  const existing = await getAlias(serverId, id, namespace);
  if (!existing) throw new AliasNotFoundError(id);

  await execute(
    serverId,
    `UPDATE forwardings SET active = ${active ? 1 : 0} WHERE id = ${qInt(id)} AND is_alias = 1${ownedDomain(namespace)}`,
  );
  await recountDomain(serverId, existing.domain, namespace);

  const row = await getAlias(serverId, id, namespace);
  if (!row) throw new AliasNotFoundError(id);
  return row;
}

export async function deleteAlias(serverId: string, id: number, namespace?: string): Promise<void> {
  const existing = await getAlias(serverId, id, namespace);
  if (!existing) throw new AliasNotFoundError(id);

  await execute(serverId, `DELETE FROM forwardings WHERE id = ${qInt(id)} AND is_alias = 1${ownedDomain(namespace)}`);
  await recountDomain(serverId, existing.domain, namespace);
}

// ─── Typed errors ────────────────────────────────────────────────────────────

export class AliasNotFoundError extends Error {
  constructor(public id: number) {
    super(`Alias not found: ${id}`);
  }
}

export class AliasExistsError extends Error {
  constructor(public address: string, public forwarding: string) {
    super(`Alias already exists: ${address} -> ${forwarding}`);
  }
}

export class AliasConflictsWithMailboxError extends Error {
  constructor(public address: string) {
    super(`${address} is a real mailbox - creating an alias here would redirect its mail. Edit or delete the mailbox instead.`);
  }
}
