/**
 * Maildir path generation + on-disk creation.
 *
 * iRedMail's convention (matches iRedAdmin's `iredutils.generate_maildir_path`):
 *
 *   <storagebasedirectory>/<storagenode>/<domain>/<u>/<us>/<user>-<YYYYMMDDHHMMSS>/
 *
 * The {u, us} hash segments distribute users across two levels of
 * subdirectories so a domain with many mailboxes doesn't end up as one
 * huge inode listing. The trailing timestamp lets the same local-part be
 * re-created after a hard delete without colliding with leftover files
 * (iRedAdmin uses the same trick).
 *
 * Storage layout for openship:
 *   storagebasedirectory = "/var/vmail"   (iRedMail default)
 *   storagenode          = "vmail1"        (iRedMail default; one node only)
 *
 * Both are stored in `vmail.mailbox` columns of the same names so Dovecot's
 * `userdb` query returns them and the LDA places mail in the right path.
 */

import { mailEngineCommand, runMailCommand, type MailTarget } from "../mail-engine";

export const STORAGE_BASE = "/var/vmail";
export const STORAGE_NODE = "vmail1";

export interface MaildirLayout {
  storagebasedirectory: string;
  storagenode: string;
  /** Relative path under <storage_base>/<storage_node>/ - what goes in vmail.mailbox.maildir. */
  maildir: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function timestampSuffix(now: Date): string {
  return (
    `${now.getUTCFullYear()}` +
    `${pad2(now.getUTCMonth() + 1)}` +
    `${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}` +
    `${pad2(now.getUTCMinutes())}` +
    `${pad2(now.getUTCSeconds())}`
  );
}

/**
 * Compute the maildir layout for a new mailbox. Pure function - does not
 * touch the network.
 *
 *   generateMaildir("acme.com", "alice")
 *   → {
 *       storagebasedirectory: "/var/vmail",
 *       storagenode: "vmail1",
 *       maildir: "acme.com/a/al/alice-20260524103000/",
 *     }
 *
 * The trailing slash matches the iRedAdmin convention. Dovecot strips/adds
 * it as needed.
 */
export function generateMaildir(
  domain: string,
  username: string,
  now: Date = new Date(),
): MaildirLayout {
  const u = username.charAt(0).toLowerCase();
  const us = username.slice(0, 2).toLowerCase().padEnd(2, u);
  return {
    storagebasedirectory: STORAGE_BASE,
    storagenode: STORAGE_NODE,
    maildir: `${domain}/${u}/${us}/${username}-${timestampSuffix(now)}/`,
  };
}

/**
 * The maildir root INSIDE the mailbox home, i.e. what Dovecot actually opens.
 *
 * `mail_location = maildir:%Lh/Maildir/:INDEX=%Lh/Maildir/` (engine/samples/dovecot/
 * dovecot.conf:64) and the userdb query sets `home` to
 * `<storagebasedirectory>/<storagenode>/<maildir>` (dovecot-sql.conf:19) — so the
 * tree lives one level BELOW the home, not at it. This used to create
 * `<home>/{cur,new,tmp}`, a tree Dovecot never reads: harmless only because the LDA
 * autocreates the real one on first delivery, which is also why nothing caught it.
 */
const MAILDIR_SUBDIR = "Maildir";

/**
 * Create the Maildir directory tree where the mail engine lives:
 *
 *   /var/vmail/vmail1/<maildir>/Maildir/{cur,new,tmp}
 *
 * Owned by `vmail:vmail` (the system user iRedMail's installer creates) so
 * Postfix/Dovecot can write into it. Mode `0700` per Dovecot's expectation.
 *
 * Runs through `runMailCommand`, so it lands wherever `/var/vmail` and the `vmail`
 * user actually are. Running it bare on the host executor is half of #562: a
 * container-flavor host has no `vmail` user, so `chown` failed, the `&&` chain
 * failed, and mailbox creation 500'd after already inserting the DB rows.
 *
 * The whole chain is handed to ONE `sh -c` rather than joined with `&&` at the top
 * level, because `mailEngineCommand` prefixes `docker exec <container>` — an
 * unwrapped `a && b` would run `a` in the engine and `b` on the HOST. Same wrapping
 * precedent as mail.service.ts:91 and :863.
 *
 * Idempotent: `mkdir -p` is fine if the path already exists, and `chown`
 * over an existing tree is harmless.
 */
export async function createMaildirOnDisk(
  serverIdOrExec: MailTarget,
  layout: MaildirLayout,
): Promise<void> {
  // Trailing slash already in maildir field; we don't need to add it again.
  const home = maildirHome(layout);
  const root = `${home}${MAILDIR_SUBDIR}`;
  const script = [
    `mkdir -p ${shellQuote(`${root}/cur`)} ${shellQuote(`${root}/new`)} ${shellQuote(`${root}/tmp`)}`,
    `chown -R vmail:vmail ${shellQuote(home)}`,
    `chmod -R 0700 ${shellQuote(home)}`,
  ].join(" && ");

  await runMailCommand(serverIdOrExec, (flavor) =>
    mailEngineCommand(flavor, `sh -c ${shellQuote(script)}`),
  );
}

/**
 * Remove the Maildir directory tree from disk. Used by hard delete.
 *
 * We use `rm -rf` against the computed full path. The path is built from
 * the mailbox row's stored values, never from untrusted input - `vmail`
 * is the only legitimate writer of the maildir column, and the controller
 * has already validated the mailbox exists.
 */
export async function removeMaildirOnDisk(
  serverIdOrExec: MailTarget,
  layout: MaildirLayout,
): Promise<void> {
  const fullPath = maildirHome(layout);
  // Guard: refuse to rm -rf anything that's not under /var/vmail/
  if (!fullPath.startsWith(`${STORAGE_BASE}/`)) {
    throw new Error(
      `Refusing to remove maildir outside ${STORAGE_BASE}/: ${fullPath}`,
    );
  }
  // Removes the home, so the `Maildir/` subtree inside it goes with it — no need to
  // know the layout below. Flavor-routed for the same reason as the create path:
  // `/var/vmail` is a volume in the engine, not a host directory.
  await runMailCommand(serverIdOrExec, (flavor) =>
    mailEngineCommand(flavor, `rm -rf ${shellQuote(fullPath)}`),
  );
}

/** The mailbox home — what the userdb query returns as `home`. Keeps the one path
 *  concatenation in a single place so create and remove cannot disagree. */
function maildirHome(layout: MaildirLayout): string {
  return `${layout.storagebasedirectory}/${layout.storagenode}/${layout.maildir}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
