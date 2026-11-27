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
    maildir: `${domain}/${u === "." ? "_" : u}/${/^\.{1,2}$/.test(us) ? "_" : us}/${username}-${timestampSuffix(now)}/`,
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
  const dirs = [home.slice(0, -1), root, ...["cur", "new", "tmp"].map((dir) => `${root}/${dir}`)];
  const script = [
    ...dirs.map(canonicalPathCheck),
    `mkdir -p ${dirs.slice(2).map(shellQuote).join(" ")}`,
    `chown vmail:vmail ${dirs.map(shellQuote).join(" ")}`,
    `chmod 0700 ${dirs.map(shellQuote).join(" ")}`,
  ].join(" && ");

  await runMailCommand(serverIdOrExec, (flavor) =>
    mailEngineCommand(flavor, `sh -c ${shellQuote(script)}`),
  );
}

/** Delete only a mailbox home under its storage node. Resolve the path on
 * the mail host so that a symlink cannot redirect cleanup to a different home. */
export async function removeMaildirOnDisk(
  serverIdOrExec: MailTarget,
  layout: MaildirLayout,
  expectedDomain?: string,
): Promise<void> {
  const home = maildirHome(layout, expectedDomain).slice(0, -1);
  const script = `${canonicalPathCheck(home)} && rm -rf -- ${shellQuote(home)}`;
  await runMailCommand(serverIdOrExec, (flavor) =>
    mailEngineCommand(flavor, `sh -c ${shellQuote(script)}`),
  );
}

function canonicalPathCheck(path: string): string {
  const quoted = shellQuote(path);
  return `[ "$(realpath -m -- ${quoted})" = ${quoted} ]`;
}

function maildirHome(layout: MaildirLayout, expectedDomain?: string): string {
  const parts = layout.maildir.replace(/\/$/, "").split("/");
  if (layout.storagebasedirectory !== STORAGE_BASE || layout.storagenode.includes("/") ||
      parts.length < 2 || [layout.storagenode, ...parts].some((p) => !p || p === "." || p === ".." || /[\x00-\x1f]/.test(p)) ||
      (expectedDomain !== undefined && parts[0] !== expectedDomain))
    throw new Error("Refusing maildir outside its mailbox storage location.");
  return `${STORAGE_BASE}/${layout.storagenode}/${parts.join("/")}/`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
