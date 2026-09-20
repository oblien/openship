/**
 * Password hashing for vmail.mailbox / vmail.admin rows.
 *
 * iRedMail's default dovecot-sql.conf expects `{SSHA512}<base64>` in the
 * `password` column. Hashing happens ON the target VPS via `doveadm pw`
 * so neither cleartext nor hash transits any intermediate process.
 *
 * "On the target VPS" is not the same as "on the target HOST": `doveadm` lives
 * wherever Dovecot does, which on a container-flavor box is inside the engine and
 * NOT on the host. Running it bare against the host executor is what made every
 * mailbox create return a 500 on a containerized install (#562) — the host has no
 * `doveadm`, so the exec produced nothing, the hash regex rejected the empty
 * string, and the thrown message never reached the operator. Every invocation now
 * goes through `runMailCommand`, which resolves the box's flavor and renders the
 * right prefix; see `../mail-engine.ts` for the topology matrix.
 *
 * This is the same scheme used by `mail-credentials.service.ts` for the
 * postmaster password rotation - kept as a separate small module so the
 * admin services can call it without depending on the broader credentials
 * surface.
 */

import { mailEngineCommand, runMailCommand, type MailTarget } from "../mail-engine";

const SSHA512_HASH_RE = /^\{SSHA512\}[A-Za-z0-9+/=]+$/;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Hash a plaintext password via `doveadm pw -s SSHA512`. Returns the raw
 * `{SSHA512}...` string ready to drop into the `password` column.
 *
 * Throws if doveadm returns anything that doesn't match the expected hash
 * format - easier to fail at hash time than to debug a broken auth row. The
 * plaintext is never echoed in that error, only the (non-)hash we got back.
 */
export async function hashPassword(
  serverIdOrExec: MailTarget,
  plaintext: string,
): Promise<string> {
  const { output, flavor } = await runMailCommand(serverIdOrExec, (f) =>
    mailEngineCommand(f, `doveadm pw -s SSHA512 -p ${shellQuote(plaintext)}`),
  );

  const hash = output.trim();
  if (!SSHA512_HASH_RE.test(hash)) {
    // Name the transport in the message: on a container box the overwhelmingly
    // likely cause is that `doveadm` is missing from the engine image, and an
    // error that only says "unexpected output" sends the reader hunting the
    // password instead.
    throw new Error(
      `doveadm pw (${flavor} engine) returned no usable SSHA512 hash — got ${
        hash ? `"${hash.slice(0, 60)}…"` : "empty output"
      }. Check that doveadm is present and Dovecot's config is readable.`,
    );
  }
  return hash;
}
