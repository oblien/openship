/**
 * Per-domain test mailbox — provisions `openship@<domain>` as a real SMTP
 * identity inside `vmail.mailbox` for an additional domain (one already
 * present in `vmail.domain`). Sibling to `ensureOpenshipPlatformMailbox`:
 *
 *   - ensureOpenshipPlatformMailbox(serverId)               → openship@<state.domain>, the SINGLE
 *                                                             auth identity the API uses for all
 *                                                             transactional mail.
 *   - ensureOpenshipTestMailbox(serverId, domain)           → openship@<domain>, one per
 *                                                             provisioned domain, used by the
 *                                                             admin panel's "send test mail
 *                                                             from this domain" flow to
 *                                                             verify deliverability scoped to
 *                                                             a specific brand.
 *
 * Reuses the platform-mailbox helpers verbatim — same password generation,
 * doveadm hashing, maildir layout, UPSERT shape, encryption-at-rest in
 * mail-state.json. The only thing that differs is WHERE creds land in
 * state: `testMailboxes[domain]` instead of `platformMailbox`.
 *
 * Idempotency contract mirrors the platform helper:
 *   - Re-running with the same args is safe; fast path returns cached creds
 *     from state.testMailboxes[domain].
 *   - DB row (hashed) and state-file entry (encrypted plaintext) are
 *     written in the same logical operation; state-file failure rolls the
 *     DB row + maildir back to keep both ends in lockstep.
 *   - rotate=true forces a fresh password through the slow path.
 *
 * Domain must already exist in `vmail.domain` — we refuse with a clear
 * error otherwise. The operator must add the domain through the Domains
 * tab first; that's the only place we provision postmaster + DNS records
 * + iRedMail-managed plumbing, and creating a stranded test mailbox under
 * a domain the rest of the stack doesn't know about would be a confusing
 * footgun.
 */

import type { CommandExecutor } from "@repo/adapters";
import { safeErrorMessage, mailHostname } from "@repo/core";
import { decrypt, encrypt } from "../../../lib/encryption";
import { sshManager } from "../../../lib/ssh-manager";
import {
  readState,
  mutateState,
  type MailServerState,
  type TestMailboxState,
} from "../mail-state";
import {
  buildCreds,
  buildUpsertMailboxSql,
  buildUpsertSelfForwardingSql,
  DOMAIN_RE,
  PLATFORM_LOCAL_PART,
  PlatformMailboxError,
  randomPassword,
  rollbackMailbox,
  type PlatformMailboxCreds,
} from "./platform-mailbox.service";
import { transaction, queryOne, q } from "./psql-runner";
import { hashPassword } from "./password";
import {
  createMaildirOnDisk,
  generateMaildir,
} from "./maildir";
import { recountDomain } from "./domains.service";

export interface EnsureOpenshipTestMailboxOptions {
  /** Force a fresh password even if cached creds exist. */
  rotate?: boolean;
}

/**
 * Provision (or reuse) `openship@<domain>` as a per-domain test mailbox.
 *
 * Fast path: `state.testMailboxes[domain].email` matches and `rotate` is
 * not set — pure read, decrypt cached password, return.
 *
 * Slow path: validate the domain exists in `vmail.domain`, mint a 24-byte
 * base64url password, hash via doveadm, UPSERT mailbox + self-forwarding
 * rows in one transaction, ensure the maildir, then write the encrypted
 * plaintext into `state.testMailboxes[domain]`. State-file failure rolls
 * back the DB row + maildir (same pattern as the platform helper).
 */
export async function ensureOpenshipTestMailbox(
  serverId: string,
  domain: string,
  opts?: EnsureOpenshipTestMailboxOptions,
): Promise<PlatformMailboxCreds> {
  return sshManager.withExecutor(serverId, async (exec) => {
    const state = await readState(exec);
    if (!state || !state.domain) {
      throw new PlatformMailboxError(
        "Mail state not found — finish the mail install before provisioning a test mailbox.",
      );
    }

    const rawDomain = domain?.trim().toLowerCase();
    if (!rawDomain || !DOMAIN_RE.test(rawDomain) || rawDomain.length > 255) {
      throw new PlatformMailboxError(`Invalid test mailbox domain: ${domain}`);
    }
    const targetDomain = rawDomain;
    const email = `${PLATFORM_LOCAL_PART}@${targetDomain}`;
    // Submission host is always the primary install — every domain shares
    // the same `mail.<state.domain>` MX / submission endpoint.
    const smtpHost = mailHostname(state.domain);
    const rotate = opts?.rotate === true;

    // Fast path: cached creds match target identity and no rotation
    // requested. The stored password is an encrypted blob (slow path
    // encrypts before persist). Legacy-plaintext fallback mirrors the
    // platform helper — log once and use the raw value; next rotation
    // re-encrypts.
    const cached = state.testMailboxes?.[targetDomain];
    if (!rotate && cached && cached.email === email && cached.password) {
      let plaintext: string;
      try {
        plaintext = decrypt(cached.password);
      } catch {
        console.warn(
          `[ensureOpenshipTestMailbox] state.testMailboxes["${targetDomain}"].password failed to decrypt — treating as legacy plaintext. It will be re-encrypted on next rotation.`,
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

    // Slow path: confirm the domain row exists, then mint + UPSERT + persist.
    const exists = await queryOne<{ domain: string }>(
      exec,
      `SELECT domain FROM domain WHERE domain = ${q(targetDomain)}`,
    );
    if (!exists) {
      throw new PlatformMailboxError(
        `Domain not provisioned: ${targetDomain}. Add it through the admin Domains tab first.`,
      );
    }

    return mintAndPersist({ exec, serverId, state, domain: targetDomain, email, smtpHost });
  });
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
      name: "Openship Test",
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
      `Failed to create test mailbox maildir for ${domain}; mailbox row rolled back: ${safeErrorMessage(err)}`,
    );
  }

  // 3. Persist the credential to mail-state.json under
  //    `testMailboxes[domain]`. Same drift-prevention rollback as the
  //    platform helper: if THIS write fails, undo the DB row + maildir
  //    so we never end up with "DB has hash, state has no credential".
  const nextEntry: TestMailboxState = {
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
      testMailboxes: {
        ...(s.testMailboxes ?? {}),
        [domain]: nextEntry,
      },
    }));
  } catch (err) {
    await rollbackMailbox(exec, email, layout).catch(() => {});
    throw new PlatformMailboxError(
      `Failed to persist test mailbox to mail-state.json; mailbox row + maildir rolled back: ${safeErrorMessage(err)}`,
    );
  }

  // 4. Refresh domain counters so the admin panel reflects the new mailbox.
  //    Counter drift is cosmetic; never fail the ensure on it.
  try {
    await recountDomain(serverId, domain);
  } catch {
    // ignore
  }

  return buildCreds({ email, password: plaintext, smtpHost, rotated: true });
}
