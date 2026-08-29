/**
 * Mail-credentials operations - change the postmaster password after install.
 *
 * Flow:
 *   1. Hash the new password with `doveadm pw -s SSHA512` (the scheme
 *      iRedMail's default `dovecot-sql.conf` uses for the `password`
 *      column), via the shared `admin/password.ts` helper. Hashing on the
 *      target server avoids sending the cleartext or the hash through any
 *      intermediate process.
 *   2. UPDATE vmail.mailbox SET password = … through `admin/psql-runner`.
 *   3. Scrub any leftover plaintext from the state file. We used to mirror
 *      it back for the credentials card to display; that was a needless
 *      attack surface and is gone - the only way to "know" the password
 *      now is to set one via this flow.
 */

import type { CommandExecutor } from "@repo/adapters";
import { hashPassword } from "./admin/password";
import { execute, q } from "./admin/psql-runner";
import { readState, mutateState } from "./mail-state";

/**
 * Update the postmaster password for `<domain>`. Caller is responsible
 * for validation (length, etc.) - this function trusts the input.
 *
 * `domain` is the mail domain (e.g. "example.com"), NOT `mail.example.com`.
 * The postmaster account is always `postmaster@<domain>`.
 */
export async function updatePostmasterPassword(
  exec: CommandExecutor,
  domain: string,
  newPassword: string,
): Promise<void> {
  const username = `postmaster@${domain}`;
  // Shared with the admin panel's mailbox create/update, so the hash scheme and the
  // engine-vs-host transport are decided in exactly one place. This used to be a
  // private copy that ran `doveadm` bare on the host executor, which is dead on a
  // container-flavor box (#562) — the same defect the mailbox-create path had.
  const hash = await hashPassword(exec, newPassword);

  // Belt-and-suspenders against an upstream surprise: the username is derived from an
  // already-validated domain, and `hashPassword` has its own format gate.
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(username)) {
    throw new Error(`Refusing to update for suspicious username: ${username}`);
  }

  // Through psql-runner so the invocation matches the box's topology (the engine's pg
  // sidecar, or `sudo -u postgres` on a legacy install) rather than assuming the latter.
  await execute(
    exec,
    `UPDATE mailbox SET password = ${q(hash)} WHERE username = ${q(username)};`,
  );

  // Persist the new plaintext into state.secrets so the test-email flow
  // (and any future SMTP-from-orchestrator use) can authenticate over
  // submission as postmaster@<domain> without scraping it from disk.
  //
  // The state file lives at `/root/.openship/mail-state.json` with root-
  // only permissions; an attacker with read access there already has
  // /etc/dovecot/dovecot-sql.conf and the bind credentials. Keeping the
  // postmaster plaintext alongside the other generated secrets doesn't
  // widen the blast radius - it just keeps the orchestrator able to act
  // as the mail server's own admin without paging the operator.
  const state = await readState(exec);
  if (state) {
    await mutateState(exec, state.serverId, (s) => ({
      ...s,
      secrets: { ...s.secrets, DOMAIN_ADMIN_PASSWD_PLAIN: newPassword },
    }));
  }
}
