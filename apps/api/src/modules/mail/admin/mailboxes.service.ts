/**
 * Mailbox CRUD for the mail admin panel.
 *
 * A "mailbox" in iRedMail is three artifacts that must stay in sync:
 *
 *   1. `vmail.mailbox` - auth row + storage layout + per-protocol enable
 *      flags. Dovecot's userdb query reads this.
 *   2. `vmail.forwardings` - a self-forwarding row (address = forwarding =
 *      username, is_forwarding=1). Postfix's recipient lookup goes through
 *      this table, so without it mail to the address is rejected even if
 *      the mailbox row exists.
 *   3. On-disk Maildir at <storage_base>/<storage_node>/<maildir>. Dovecot
 *      creates folders on first delivery, but the parent must exist with
 *      the right ownership.
 *
 * `createMailbox` does (1) + (2) inside a single transaction, then attempts
 * (3). If the on-disk step fails we roll back the DB to keep the three
 * artifacts in sync.
 *
 * Quota is stored in MB (iRedMail/iRedAdmin convention) - 0 means unlimited.
 * The UI converts to/from GB.
 */

import { sshManager } from "../../../lib/ssh-manager";
import { execute, queryOne, queryRows, q, qInt, transaction } from "./psql-runner";
import { hashPassword } from "./password";
import {
  createMaildirOnDisk,
  generateMaildir,
  removeMaildirOnDisk,
  STORAGE_BASE,
  STORAGE_NODE,
} from "./maildir";
import { recountDomain, validateDomain } from "./domains.service";
import { buildInsertMailboxSql, buildInsertSelfForwardingSql } from "./platform-mailbox.service";
import { safeErrorMessage } from "@repo/core";
import { readState } from "../mail-state";

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const LOCAL_PART_RE = /^[a-z0-9._+-]+$/;

export interface MailboxRow {
  username: string;
  name: string;
  domain: string;
  quotaMB: number;
  storagebasedirectory: string;
  storagenode: string;
  maildir: string;
  active: boolean;
  isAdmin: boolean;
  isGlobalAdmin: boolean;
  createdAt: string;
  passwordLastChange: string;
}

const SELECT_COLUMNS = `
  username,
  name,
  domain,
  quota AS "quotaMB",
  storagebasedirectory,
  storagenode,
  maildir,
  (active = 1) AS active,
  (isadmin = 1) AS "isAdmin",
  (isglobaladmin = 1) AS "isGlobalAdmin",
  created::text AS "createdAt",
  passwordlastchange::text AS "passwordLastChange"
`;

export interface CreateMailboxInput {
  /** Local-part only - domain is supplied separately. */
  localPart: string;
  domain: string;
  password: string;
  /** Display name (e.g. "Alice Carter"). Optional. */
  name?: string;
  /** Quota in MB (0 = unlimited). Defaults to domain.maxquota or 0. */
  quotaMB?: number;
}

export interface UpdateMailboxInput {
  name?: string;
  /** Plaintext - service hashes via doveadm before storing. */
  password?: string;
  quotaMB?: number;
  active?: boolean;
}

function validateEmail(email: string): void {
  if (!EMAIL_RE.test(email) || email.length > 255) {
    throw new Error(`Invalid email: ${email}`);
  }
}

function validateLocalPart(local: string): void {
  if (!LOCAL_PART_RE.test(local) || local.length === 0 || local.length > 64) {
    throw new Error(`Invalid local-part: ${local}`);
  }
}

function validateQuotaMB(quota: number): void {
  if (!Number.isFinite(quota) || quota < 0) {
    throw new Error(`Invalid quota (MB): ${quota}`);
  }
}

/**
 * Validate a free-form display name at the API boundary (defense-in-depth).
 * A display name is DATA — reject control characters (newlines/CR/NUL/…) that
 * have no legitimate place in a name and are the vehicle for injection, and cap
 * the length. The SQL sink is already safe (q() + a single shell-quoted `-c`
 * arg); this is a second layer so bad input never even reaches it.
 */
function validateDisplayName(name: string): void {
  if (name.length > 255) {
    throw new Error("Display name too long (max 255 characters).");
  }
  // Reject control characters (newlines/CR/NUL/DEL) — they never belong in a
  // display name and are the vehicle for injection. charCodeAt avoids a
  // control-char regex literal in source.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error("Display name contains invalid control characters.");
    }
  }
}

export async function listMailboxes(serverId: string, domain: string): Promise<MailboxRow[]> {
  validateDomain(domain);
  return queryRows<MailboxRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM mailbox WHERE domain = ${q(domain.toLowerCase())} ORDER BY username`,
  );
}

export async function getMailbox(serverId: string, email: string): Promise<MailboxRow | null> {
  validateEmail(email);
  return queryOne<MailboxRow>(
    serverId,
    `SELECT${SELECT_COLUMNS} FROM mailbox WHERE username = ${q(email.toLowerCase())}`,
  );
}

/**
 * Create a mailbox. Does NOT use a single SQL transaction across the disk
 * operation - see the rollback in the catch below.
 */
export async function createMailbox(
  serverId: string,
  input: CreateMailboxInput,
): Promise<MailboxRow> {
  validateLocalPart(input.localPart);
  validateDomain(input.domain);
  if (input.name) validateDisplayName(input.name);
  if (!input.password || input.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const quotaMB = input.quotaMB ?? 0;
  validateQuotaMB(quotaMB);

  const username = `${input.localPart}@${input.domain}`.toLowerCase();
  validateEmail(username);

  // Duplicate check (friendlier than letting Postgres' unique constraint fire).
  const existing = await getMailbox(serverId, username);
  if (existing) {
    throw new MailboxExistsError(username);
  }

  await sshManager.withExecutor(serverId, async (exec) => {
    const hash = await hashPassword(exec, input.password);
    const layout = generateMaildir(input.domain.toLowerCase(), input.localPart);

    // 1. Insert mailbox + matching forwardings row atomically.
    await transaction(exec, [
      buildInsertMailboxSql({
        username,
        passwordHash: hash,
        name: input.name ?? "",
        domain: input.domain.toLowerCase(),
        quotaMB,
        storagebasedirectory: layout.storagebasedirectory,
        storagenode: layout.storagenode,
        maildir: layout.maildir,
      }),
      buildInsertSelfForwardingSql(username, input.domain.toLowerCase()),
    ]);

    // 2. Create Maildir on disk. If this throws, roll back the DB rows so
    //    we don't leave a phantom mailbox the user can't log into.
    try {
      await createMaildirOnDisk(exec, layout);
    } catch (err) {
      // Best-effort rollback. If THIS also fails we're in trouble - but the
      // most likely cause is "no write access to /var/vmail" which means
      // the install is broken regardless, and the DB rollback should still
      // work.
      await execute(exec, `DELETE FROM mailbox WHERE username = ${q(username)};`);
      await execute(
        exec,
        `DELETE FROM forwardings WHERE address = ${q(username)} AND forwarding = ${q(username)};`,
      );
      throw new Error(
        `Failed to create Maildir; mailbox was rolled back: ${safeErrorMessage(err)}`,
      );
    }

    // 3. Refresh the domain counter.
    await recountDomain(serverId, input.domain);
  });

  const row = await getMailbox(serverId, username);
  if (!row) throw new Error(`createMailbox: row not found after INSERT for ${username}`);
  return row;
}

export async function updateMailbox(
  serverId: string,
  email: string,
  patch: UpdateMailboxInput,
): Promise<MailboxRow> {
  validateEmail(email);
  const username = email.toLowerCase();

  const existing = await getMailbox(serverId, username);
  if (!existing) throw new MailboxNotFoundError(username);

  await sshManager.withExecutor(serverId, async (exec) => {
    const sets: string[] = ["modified = NOW()"];

    if (patch.name !== undefined) {
      validateDisplayName(patch.name);
      sets.push(`name = ${q(patch.name)}`);
    }
    if (patch.quotaMB !== undefined) {
      validateQuotaMB(patch.quotaMB);
      sets.push(`quota = ${qInt(patch.quotaMB)}`);
    }
    if (patch.active !== undefined) {
      sets.push(`active = ${patch.active ? 1 : 0}`);
    }
    if (patch.password) {
      if (patch.password.length < 8) {
        throw new Error("Password must be at least 8 characters.");
      }
      const hash = await hashPassword(exec, patch.password);
      sets.push(`password = ${q(hash)}`);
      sets.push("passwordlastchange = NOW()");
    }

    if (sets.length > 1) {
      await execute(exec, `UPDATE mailbox SET ${sets.join(", ")} WHERE username = ${q(username)}`);
    }

    // Mirror active flag on the forwardings row so Postfix stops accepting
    // mail when the mailbox is disabled.
    if (patch.active !== undefined) {
      await execute(
        exec,
        `UPDATE forwardings SET active = ${patch.active ? 1 : 0}
           WHERE address = ${q(username)} AND forwarding = ${q(username)}`,
      );
      await recountDomain(serverId, existing.domain);
    }
  });

  const row = await getMailbox(serverId, username);
  if (!row) throw new MailboxNotFoundError(username);
  return row;
}

/**
 * Soft-delete: `active = 0` + an audit row in `vmail.deleted_mailboxes`.
 * Maildir is left on disk. Postfix stops accepting mail; Dovecot login fails.
 *
 * iRedMail ships a cron job (`cleanup_deleted_mailboxes`) that periodically
 * scans `vmail.deleted_mailboxes` and hard-deletes anything past its
 * `delete_date`. We set `delete_date` to NOW() so the cron picks it up on
 * its next run, but the data is recoverable in between.
 */
export async function softDeleteMailbox(
  serverId: string,
  email: string,
  adminUsername: string,
): Promise<void> {
  validateEmail(email);
  const username = email.toLowerCase();
  const existing = await getMailbox(serverId, username);
  if (!existing) throw new MailboxNotFoundError(username);

  await sshManager.withExecutor(serverId, async (exec) => {
    await transaction(exec, [
      `UPDATE mailbox SET active = 0, modified = NOW() WHERE username = ${q(username)}`,
      `UPDATE forwardings SET active = 0 WHERE address = ${q(username)} AND forwarding = ${q(username)}`,
      `INSERT INTO deleted_mailboxes (
          username, domain, maildir, admin, delete_date
        ) VALUES (
          ${q(username)},
          ${q(existing.domain)},
          ${q(existing.maildir)},
          ${q(adminUsername)},
          CURRENT_DATE
        )`,
    ]);
    await recountDomain(serverId, existing.domain);
  });
}

/**
 * Hard-delete: removes the DB rows AND the Maildir on disk.
 *
 * The maildir path is read from the EXISTING row, never taken from caller
 * input, so we can't be tricked into rm-ing an arbitrary path. `removeMaildirOnDisk`
 * additionally guards against any path outside /var/vmail/.
 */
export async function hardDeleteMailbox(serverId: string, email: string): Promise<void> {
  validateEmail(email);
  const username = email.toLowerCase();
  const existing = await getMailbox(serverId, username);
  if (!existing) throw new MailboxNotFoundError(username);

  await sshManager.withExecutor(serverId, async (exec) => {
    // Only the install domain's postmaster is infrastructure. Additional
    // domains also get a postmaster mailbox, but it must remain removable so
    // cascade deletion can empty and drop those domains.
    if (username.startsWith("postmaster@")) {
      const installDomain = (await readState(exec))?.domain?.toLowerCase();
      if (!installDomain || username === `postmaster@${installDomain}`) {
        throw new Error(
          `Refusing to hard-delete the postmaster mailbox (${existing.username}). Use soft delete instead.`,
        );
      }
    }

    await transaction(exec, [
      `DELETE FROM forwardings WHERE address = ${q(username)} OR forwarding = ${q(username)}`,
      `DELETE FROM used_quota WHERE username = ${q(username)}`,
      `DELETE FROM last_login WHERE username = ${q(username)}`,
      `DELETE FROM deleted_mailboxes WHERE username = ${q(username)}`,
      `DELETE FROM mailbox WHERE username = ${q(username)}`,
    ]);
    try {
      await removeMaildirOnDisk(exec, {
        storagebasedirectory: existing.storagebasedirectory || STORAGE_BASE,
        storagenode: existing.storagenode || STORAGE_NODE,
        maildir: existing.maildir,
      });
    } catch {
      // Disk cleanup failure is non-fatal - the auth rows are gone, the
      // mailbox can't be logged into. Leftover bytes are an operator
      // cleanup task, not a user-facing error.
    }
    await recountDomain(serverId, existing.domain);
  });
}

// ─── Typed errors ────────────────────────────────────────────────────────────

export class MailboxExistsError extends Error {
  constructor(public username: string) {
    super(`Mailbox already exists: ${username}`);
  }
}

export class MailboxNotFoundError extends Error {
  constructor(public username: string) {
    super(`Mailbox not found: ${username}`);
  }
}
