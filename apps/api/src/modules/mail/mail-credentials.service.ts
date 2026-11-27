/** Rotate the installation postmaster password and update its private setup state. */
import type { CommandExecutor } from "@repo/adapters";
import { hashPassword } from "@repo/platform/engine/modules/mail/admin/password";
import { execute, q } from "@repo/platform/engine/modules/mail/admin/psql-runner";
import { readState, mutateState } from "@repo/platform/engine/modules/mail/mail-state";

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
  const hash = hashPassword(newPassword);

  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(username)) {
    throw new Error(`Refusing to update for suspicious username: ${username}`);
  }

  // Through psql-runner so the invocation matches the box's topology (the engine's pg
  // sidecar, or `sudo -u postgres` on a legacy install) rather than assuming the latter.
  await execute(
    exec,
    "DO " + q(`BEGIN
      UPDATE mailbox SET password = ${q(hash)}, passwordlastchange = NOW() WHERE username = ${q(username)};
      IF NOT FOUND THEN RAISE EXCEPTION 'Installation postmaster mailbox missing'; END IF;
    END`),
  );

  // Keep the private installation state consistent with the engine for recovery.
  const state = await readState(exec);
  if (state) {
    await mutateState(exec, state.serverId, (s) => ({
      ...s,
      secrets: { ...s.secrets, DOMAIN_ADMIN_PASSWD_PLAIN: newPassword },
    }));
  }
}
