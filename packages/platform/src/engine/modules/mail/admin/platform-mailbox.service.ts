/**
 * Platform mailbox — the single SMTP identity the openship API authenticates
 * as for transactional mail (welcome emails, alerts, future user-invite
 * sends).
 *
 * The mailbox lives at `openship@<state.domain>` (the primary install
 * domain). It is provisioned once by the post-install hook and reused
 * everywhere; per-tenant outbound identities are NOT minted here. iRedMail's
 * amavis DKIM config signs outbound mail based on the From-header domain,
 * NOT the SMTP-AUTH user's domain, so the single platform mailbox can still
 * send `From: openship@<any-domain>` and have DKIM align — auth identity
 * stays singular while brand identity flexes.
 *
 * The `opts.domain` parameter exists for a future per-tenant outbound
 * identity path. Today, all callers should omit it and accept the
 * install-domain default. If iRedMail's `sender_login_maps` is enabled in
 * strict mode, sending `From: openship@<additional-domain>` while authed
 * as `openship@<installDomain>` will be rejected — that's a single-line
 * config tweak (add new domains to the openship mailbox's allowed
 * senders), NOT N new mailboxes.
 *
 * Idempotency contract (per the ensure* convention in apps/api/src/lib):
 *   - Re-running with the same args is safe; fast path returns cached creds
 *     only after confirming the active mailbox + self-forwarding rows still
 *     exist in vmail. The state file is a credential cache, not existence
 *     truth.
 *   - The doveadm-hashed password (vmail.mailbox) and encrypted plaintext copy
 *     (mail-state.json) are written through the same logical operation; live
 *     row validation repairs out-of-band deletion before cached reuse.
 *   - On rotate=true, BOTH ends are updated atomically: state-file write
 *     failure rolls the DB row back via hardDelete to keep them in lockstep.
 *
 * Returns the full SMTP credentials suitable for handing directly to
 * `nodemailer.createTransport(...)`. The `rotated` flag lets install/admin
 * code surface "created new platform mailbox" vs "reused existing" in audit
 * logs and the install wizard terminal.
 */

import { randomBytes } from "node:crypto";
import type { CommandExecutor } from "@repo/adapters";
import { safeErrorMessage, mailHostname } from "@repo/core";
import { decrypt, encrypt } from "../../../lib/encryption";
import { sshManager } from "../../../lib/ssh-manager";
import {
  readState,
  mutateState,
  type MailServerState,
  type PlatformMailboxState,
} from "../mail-state";
import { execute, q, qInt, queryOne, transaction } from "./psql-runner";
import { hashPassword } from "./password";
import {
  createMaildirOnDisk,
  generateMaildir,
  removeMaildirOnDisk,
  STORAGE_BASE,
  STORAGE_NODE,
} from "./maildir";
import { recountDomain } from "./domains.service";

export const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;
export const PLATFORM_LOCAL_PART = "openship";

export class PlatformMailboxError extends Error {}

export interface PlatformMailboxCreds {
  /** `openship@<domain>` */
  email: string;
  /** Plaintext, freshly minted on first run / rotation. */
  password: string;
  /** Always `mail.<state.domain>` — the DNS-resolvable submission host. */
  smtpHost: string;
  /** Implicit-TLS submission. */
  smtpPort: 465;
  secure: true;
  /** `Openship <openship@<domain>>` */
  from: string;
  /** True if this call rotated/created creds, false if reused. */
  rotated: boolean;
}

export interface EnsureOpenshipPlatformMailboxOptions {
  /**
   * Override the domain to provision the mailbox under. Reserved for a
   * future per-tenant outbound identity path; current callers should omit
   * it. Defaults to `state.domain` (the primary install).
   */
  domain?: string;
  /** Force a fresh password even if cached creds exist. */
  rotate?: boolean;
}

/**
 * Provision (or reuse) the platform SMTP mailbox.
 *
 * Fast path: `state.platformMailbox.email` matches the target email,
 * `rotate` is not set, and the active mailbox + self-forwarding rows still
 * exist. This indexed lookup is deliberately small: the state file caches the
 * credential, but vmail remains the source of truth for whether it can work.
 *
 * Slow path: mints a 24-byte base64url password, hashes via doveadm,
 * UPSERTs the mailbox row + self-forwarding row in a single SQL
 * transaction, ensures the maildir exists on disk, then writes the
 * plaintext to mail-state.json. If the state-file write fails after the
 * DB UPSERT, we hard-delete the mailbox row + maildir to keep both ends
 * in lockstep (same rollback pattern createMailbox uses for maildir
 * failures).
 */
export async function ensureOpenshipPlatformMailbox(
  serverId: string,
  opts?: EnsureOpenshipPlatformMailboxOptions,
): Promise<PlatformMailboxCreds> {
  return sshManager.withExecutor(serverId, async (exec) => {
    const state = await readState(exec);
    if (!state || !state.domain) {
      throw new PlatformMailboxError(
        "Mail state not found — finish the mail install before provisioning the platform mailbox.",
      );
    }

    const rawDomain = (opts?.domain ?? state.domain).trim().toLowerCase();
    if (!DOMAIN_RE.test(rawDomain) || rawDomain.length > 255) {
      throw new PlatformMailboxError(`Invalid platform mailbox domain: ${rawDomain}`);
    }
    const domain = rawDomain;
    const email = `${PLATFORM_LOCAL_PART}@${domain}`;
    const smtpHost = mailHostname(state.domain);
    const rotate = opts?.rotate === true;

    // Fast path: cached creds match target identity, no rotation was requested,
    // and both vmail rows required by Dovecot/Postfix still exist and are active.
    // A mailbox can be removed outside Openship (or by an older UI), so trusting
    // only mail-state.json permanently strands outbound SMTP with a stale secret.
    // The stored password is an encrypted blob (see slow-path comment below).
    // Backward-compat: if decrypt() throws, the cached value is legacy
    // plaintext from a pre-encryption write — log once and use it raw. The
    // next rotation re-encrypts via the slow path.
    const cached = state.platformMailbox;
    if (
      !rotate &&
      cached &&
      cached.email &&
      cached.email.toLowerCase() === email &&
      cached.password &&
      (await isManagedMailboxUsable(exec, email))
    ) {
      let plaintext: string;
      try {
        plaintext = decrypt(cached.password);
      } catch {
        console.warn(
          `[ensureOpenshipPlatformMailbox] state.platformMailbox.password failed to decrypt — treating as legacy plaintext. It will be re-encrypted on next rotation.`,
        );
        plaintext = cached.password;
      }
      return buildCreds({
        email: cached.email,
        password: plaintext,
        smtpHost: cached.smtpHost ?? smtpHost,
        rotated: false,
      });
    }

    if (
      !rotate &&
      cached &&
      cached.email &&
      cached.email.toLowerCase() === email &&
      cached.password
    ) {
      console.warn(
        `[ensureOpenshipPlatformMailbox] cached mailbox ${email} is missing or inactive in vmail; recreating it and rotating the stale credential.`,
      );
    }

    // Slow path: mint + UPSERT + persist.
    return mintAndPersist({
      exec,
      serverId,
      state,
      domain,
      email,
      smtpHost,
    });
  });
}

/**
 * Return whether the two live rows needed by an Openship-managed sender are
 * present and active. Both predicates use indexed equality lookups and are
 * intentionally shared with per-domain test mailboxes so cached-credential
 * validation has one implementation.
 */
export async function isManagedMailboxUsable(
  exec: CommandExecutor,
  email: string,
): Promise<boolean> {
  const row = await queryOne<{
    mailboxActive: boolean;
    forwardingActive: boolean;
  }>(
    exec,
    `SELECT
       EXISTS (
         SELECT 1 FROM mailbox
         WHERE username = ${q(email)} AND active = 1
       ) AS "mailboxActive",
       EXISTS (
         SELECT 1 FROM forwardings
         WHERE address = ${q(email)}
           AND forwarding = ${q(email)}
           AND active = 1
       ) AS "forwardingActive"`,
  );
  return row?.mailboxActive === true && row.forwardingActive === true;
}

interface MintArgs {
  exec: CommandExecutor;
  serverId: string;
  state: MailServerState;
  domain: string;
  email: string;
  smtpHost: string;
}

async function mintAndPersist(args: MintArgs): Promise<PlatformMailboxCreds> {
  const { exec, serverId, state, domain, email, smtpHost } = args;

  const plaintext = randomPassword(24);
  const hash = await hashPassword(exec, plaintext);
  const layout = generateMaildir(domain, PLATFORM_LOCAL_PART);

  // 1. UPSERT mailbox + self-forwarding row atomically.
  await transaction(exec, [
    buildUpsertMailboxSql({
      username: email,
      passwordHash: hash,
      name: "Openship Platform",
      domain,
      storagebasedirectory: layout.storagebasedirectory,
      storagenode: layout.storagenode,
      maildir: layout.maildir,
    }),
    buildUpsertSelfForwardingSql(email, domain),
  ]);

  // 2. Ensure the maildir tree exists on disk. mkdir -p is idempotent
  //    so this is safe on re-runs that hit an existing layout.
  try {
    await createMaildirOnDisk(exec, layout);
  } catch (err) {
    await rollbackMailbox(exec, email).catch(() => {});
    throw new PlatformMailboxError(
      `Failed to create platform mailbox maildir; mailbox row rolled back: ${safeErrorMessage(err)}`,
    );
  }

  // 3. Persist the credential to mail-state.json. The password field holds an
  //    encrypted blob (AES-256-GCM via lib/encryption.ts, keyed off
  //    BETTER_AUTH_SECRET) — defense-in-depth on top of the file's 0600 perm
  //    so a leaked state-file copy doesn't immediately leak SMTP auth. If
  //    THIS write fails, roll back the DB row + maildir so we never end up
  //    with "DB has hash, state has no credential" drift — the exact failure
  //    class this primitive exists to prevent.
  //
  //    Remaining plaintext secrets in MailServerState — `secrets.*`
  //    (including DOMAIN_ADMIN_PASSWD_PLAIN), `additionalDomains[d].postmasterPassword`,
  //    `webmail.brandingToken`, and `webmail.sessionEncryptionKey` — predate
  //    this change and migrate under a separate task; do not widen scope here.
  const nextPlatformMailbox: PlatformMailboxState = {
    email,
    password: encrypt(plaintext),
    smtpHost,
    smtpPort: 465,
    secure: true,
    updatedAt: new Date().toISOString(),
  };
  try {
    await mutateState(exec, serverId, (s) => ({
      ...s,
      platformMailbox: nextPlatformMailbox,
    }));
  } catch (err) {
    await rollbackMailbox(exec, email, layout).catch(() => {});
    throw new PlatformMailboxError(
      `Failed to persist platform mailbox to mail-state.json; mailbox row + maildir rolled back: ${safeErrorMessage(err)}`,
    );
  }

  // 4. Refresh domain counters so the admin panel reflects the new mailbox.
  //    recountDomain re-acquires an executor via the SSH manager (which
  //    multiplexes onto the same session) — cosmetic counter, never fail
  //    the ensure on it.
  try {
    await recountDomain(serverId, domain);
  } catch {
    // Counter drift is cosmetic; don't fail the ensure on it.
  }

  return buildCreds({ email, password: plaintext, smtpHost, rotated: true });
}

export async function rollbackMailbox(
  exec: CommandExecutor,
  email: string,
  layout?: { storagebasedirectory: string; storagenode: string; maildir: string },
): Promise<void> {
  await execute(exec, `DELETE FROM forwardings WHERE address = ${q(email)} OR forwarding = ${q(email)};`).catch(
    () => {},
  );
  await execute(exec, `DELETE FROM mailbox WHERE username = ${q(email)};`).catch(() => {});
  if (layout) {
    await removeMaildirOnDisk(exec, layout).catch(() => {});
  }
}

export function buildCreds(args: {
  email: string;
  password: string;
  smtpHost: string;
  rotated: boolean;
}): PlatformMailboxCreds {
  return {
    email: args.email,
    password: args.password,
    smtpHost: args.smtpHost,
    smtpPort: 465,
    secure: true,
    from: `Openship <${args.email}>`,
    rotated: args.rotated,
  };
}

// ─── SQL builders ────────────────────────────────────────────────────────────

export interface MailboxFields {
  username: string;
  passwordHash: string;
  name: string;
  domain: string;
  storagebasedirectory: string;
  storagenode: string;
  maildir: string;
  /**
   * Optional quota in MB; defaults to `0` (unlimited). The platform mailbox
   * is a send-only identity and always passes `0`; createMailbox forwards
   * the per-mailbox quota from CreateMailboxInput.
   */
  quotaMB?: number;
}

/** Back-compat alias for the prior, upsert-only field shape. */
export type UpsertMailboxFields = MailboxFields;

export type MailboxSqlMode = "insert" | "upsert";

export interface BuildMailboxSqlOptions {
  /** Defaults to `"upsert"` to preserve the original platform-mailbox call site. */
  mode?: MailboxSqlMode;
}

/**
 * Single source of truth for the mailbox INSERT shape.
 *
 * `mode: "insert"` is a pure INSERT — duplicate primary keys surface as a
 * typed conflict error to the caller (createMailbox uses this and presents
 * MailboxExistsError to the operator). `mode: "upsert"` (default) appends
 * the `ON CONFLICT (username) DO UPDATE SET ...` clause so a row left
 * disabled by a prior soft-delete comes back online when the platform
 * mailbox is re-ensured.
 *
 * The column set — including the explicit `isadmin = 0, isglobaladmin = 0`
 * pair — is identical across both modes. iRedMail's schema defaults those
 * columns to `0`, so the previous CRUD INSERT (which omitted them) and this
 * unified one produce identical rows.
 */
export function buildMailboxSql(
  f: MailboxFields,
  opts?: BuildMailboxSqlOptions,
): string {
  const mode = opts?.mode ?? "upsert";
  const quotaMB = f.quotaMB ?? 0;
  const base = `INSERT INTO mailbox (
      username, password, name, domain, quota,
      storagebasedirectory, storagenode, maildir,
      mailboxformat, mailboxfolder,
      enablesmtp, enablesmtpsecured,
      enableimap, enableimapsecured, enableimaptls,
      enablepop3, enablepop3secured, enablepop3tls,
      enabledeliver, enablelda, enablelmtp,
      enablemanagesieve, enablemanagesievesecured,
      enablesieve, enablesievesecured, enablesievetls,
      enableinternal, enabledoveadm, enabledsync, enablesogo,
      active, isadmin, isglobaladmin,
      created, modified, passwordlastchange
    ) VALUES (
      ${q(f.username)},
      ${q(f.passwordHash)},
      ${q(f.name)},
      ${q(f.domain)},
      ${qInt(quotaMB)},
      ${q(f.storagebasedirectory)},
      ${q(f.storagenode)},
      ${q(f.maildir)},
      'maildir', 'Maildir',
      1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1,
      1, 1, 1,
      1, 1, 1, 1,
      1, 0, 0,
      NOW(), NOW(), NOW()
    )`;
  if (mode === "insert") return base;
  return `${base}
    ON CONFLICT (username) DO UPDATE SET
      password = EXCLUDED.password,
      name = EXCLUDED.name,
      active = 1,
      enablesmtp = 1,
      enablesmtpsecured = 1,
      modified = NOW(),
      passwordlastchange = NOW()`;
}

/** Thin wrapper: pure INSERT, no ON CONFLICT. Used by createMailbox. */
export function buildInsertMailboxSql(f: MailboxFields): string {
  return buildMailboxSql(f, { mode: "insert" });
}

/** Thin wrapper: INSERT ... ON CONFLICT DO UPDATE. Used by ensure* helpers. */
export function buildUpsertMailboxSql(f: MailboxFields): string {
  return buildMailboxSql(f, { mode: "upsert" });
}

/**
 * Single source of truth for the self-forwarding row INSERT.
 *
 * `mode: "insert"` is a pure INSERT; `mode: "upsert"` (default) re-enables
 * the row on conflict so an idempotent ensure* helper restores state.
 */
export function buildSelfForwardingSql(
  username: string,
  domain: string,
  opts?: BuildMailboxSqlOptions,
): string {
  const mode = opts?.mode ?? "upsert";
  const base = `INSERT INTO forwardings (
      address, forwarding, domain, dest_domain,
      is_maillist, is_list, is_forwarding, is_alias, active
    ) VALUES (
      ${q(username)}, ${q(username)}, ${q(domain)}, ${q(domain)},
      0, 0, 1, 0, 1
    )`;
  if (mode === "insert") return base;
  return `${base}
    ON CONFLICT (address, forwarding) DO UPDATE SET
      domain = EXCLUDED.domain,
      dest_domain = EXCLUDED.dest_domain,
      is_forwarding = 1,
      active = 1`;
}

/** Thin wrapper: pure INSERT, no ON CONFLICT. Used by createMailbox. */
export function buildInsertSelfForwardingSql(username: string, domain: string): string {
  return buildSelfForwardingSql(username, domain, { mode: "insert" });
}

/** Thin wrapper: INSERT ... ON CONFLICT DO UPDATE. Used by ensure* helpers. */
export function buildUpsertSelfForwardingSql(username: string, domain: string): string {
  return buildSelfForwardingSql(username, domain, { mode: "upsert" });
}

// ─── Password generation ─────────────────────────────────────────────────────

/**
 * Generate a random URL-safe password of the requested length. base64url
 * gives us [A-Za-z0-9-_], which every SMTP client tolerates without
 * quoting.
 */
export function randomPassword(length: number): string {
  // 24 base64url chars cover ~144 bits of entropy. Generate a bit more
  // than we need and slice — base64 length-grows in chunks of 4.
  const bytes = Math.ceil((length * 3) / 4) + 4;
  return randomBytes(bytes).toString("base64url").slice(0, length);
}
