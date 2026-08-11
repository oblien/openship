/**
 * Mail backup plan — turns the operator's include-checkboxes into the
 * `custom_command` producer's payloadConfig (produce/restore shell). Mail
 * path + SQL knowledge lives here in apps/api; the backup adapter stays
 * generic (it just runs `sh -c <produceCommand>` on the source via the
 * bare SSH executor and streams stdout as one artifact).
 *
 *   produce : stage vmail dump (+ optional DKIM/config, + optional
 *             maildirs) then `tar | zstd` to stdout.
 *   restore : `zstd -d | tar -x`, load the vmail data (TRUNCATE the four
 *             account tables then COPY), restore DKIM/config + maildirs
 *             when present, recount, reload daemons.
 *
 * Data-only DB restore: rows load into the TARGET install's existing
 * `vmail` schema using the target's own daemon creds — we deliberately do
 * NOT carry DB roles/passwords (that would desync dovecot-sql.conf).
 * `{SSHA512}` password hashes are host-portable, so accounts work as-is.
 */

/** The four tables that hold accounts / domains / aliases / admins. */
const ACCOUNT_TABLES = ["domain", "mailbox", "forwardings", "domain_admins"] as const;

export interface MailBackupFlags {
  /** Include the maildir message store (/var/vmail). Large. */
  messageData: boolean;
  /** Include DKIM keys + amavis config + mail-state.json (secrets). */
  keys: boolean;
}

export interface MailBackupPayload {
  payloadKind: "custom_command";
  payloadConfig: {
    produceCommand: string;
    restoreCommand: string;
    artifactName: string;
    /** Recorded for the UI + auditing (not used by the shell). */
    mail: { messageData: boolean; keys: boolean };
  };
}

/**
 * Build the payloadConfig for a mail-server backup policy. `domain` is
 * embedded only in the archive's manifest JSON (never in a shell
 * position), so it needs no escaping beyond JSON.
 */
export function buildMailBackupPayload(
  domain: string,
  flags: MailBackupFlags,
): MailBackupPayload {
  const tableArgs = ACCOUNT_TABLES.map((t) => `-t ${t}`).join(" ");
  const truncateList = ACCOUNT_TABLES.join(", ");
  const info = JSON.stringify({ domain, messageData: flags.messageData, keys: flags.keys });

  const produceCommand = [
    "set -e",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    // Accounts + auth — always. Plain-SQL data-only dump (COPY blocks).
    `sudo -u postgres pg_dump -d vmail --data-only --no-owner --no-privileges ${tableArgs} > "$tmp/vmail.data.sql"`,
    // What's inside — read by the UI / hand-restore.
    `printf '%s' '${info.replace(/'/g, "'\\''")}' > "$tmp/mail-backup.json"`,
    flags.keys
      ? [
          'mkdir -p "$tmp/keys"',
          '[ -d /var/lib/dkim ] && cp -a /var/lib/dkim "$tmp/keys/dkim" || true',
          '[ -f /etc/amavis/conf.d/50-user ] && cp -a /etc/amavis/conf.d/50-user "$tmp/keys/amavis-50-user" || true',
          '[ -f /root/.openship/mail-state.json ] && cp -a /root/.openship/mail-state.json "$tmp/keys/mail-state.json" || true',
        ].join("\n")
      : "",
    // Stream one tar to stdout: the staged dir + (optionally) the maildirs
    // read in place (not re-copied), so the source needs no extra disk.
    flags.messageData
      ? 'tar -c -C "$tmp" . -C /var/vmail vmail1 | zstd -c -3'
      : 'tar -c -C "$tmp" . | zstd -c -3',
  ]
    .filter(Boolean)
    .join("\n");

  const restoreCommand = [
    "set -e",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    // stdin = the tar.zst artifact.
    'zstd -d | tar -x -C "$tmp"',
    // Data-only restore: wipe the target's account tables, then load.
    `sudo -u postgres psql -d vmail -v ON_ERROR_STOP=1 -c 'TRUNCATE ${truncateList} CASCADE;'`,
    'sudo -u postgres psql -d vmail -v ON_ERROR_STOP=1 -f "$tmp/vmail.data.sql"',
    // DKIM keys + amavis config (if the archive carried them).
    'if [ -d "$tmp/keys/dkim" ]; then mkdir -p /var/lib/dkim && cp -a "$tmp/keys/dkim/." /var/lib/dkim/ || true; fi',
    'if [ -f "$tmp/keys/amavis-50-user" ]; then cp -a "$tmp/keys/amavis-50-user" /etc/amavis/conf.d/50-user || true; fi',
    // Maildirs (if included). Ownership must be vmail:vmail for Dovecot.
    'if [ -d "$tmp/vmail1" ]; then cp -a "$tmp/vmail1" /var/vmail/ && chown -R vmail:vmail /var/vmail/vmail1 || true; fi',
    // Recompute per-domain counters (app-managed, not DB triggers).
    "sudo -u postgres psql -d vmail -c \"UPDATE domain d SET mailboxes=(SELECT count(*) FROM mailbox m WHERE m.domain=d.domain), aliases=(SELECT count(*) FROM forwardings f WHERE f.domain=d.domain AND f.is_alias) WHERE d.domain IS NOT NULL;\" || true",
    // Reload daemons so the restored data + keys take effect.
    "systemctl reload postfix dovecot 2>/dev/null || true; systemctl restart amavis 2>/dev/null || true",
  ].join("\n");

  return {
    payloadKind: "custom_command",
    payloadConfig: {
      produceCommand,
      restoreCommand,
      artifactName: "mail.tar.zst",
      mail: { messageData: flags.messageData, keys: flags.keys },
    },
  };
}
