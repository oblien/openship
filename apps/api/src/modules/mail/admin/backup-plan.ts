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

import { HOST_STATE_DIR } from "@repo/adapters";
import { safePipelineFragment } from "@repo/adapters";
import {
  HOST_AMAVIS_CONF_CANDIDATES,
  mailDaemonReloadCommand,
  mailEngineCommand,
  mailPgDumpToStdout,
  mailPsqlFromStdin,
  type MailEngineFlavor,
} from "../mail-engine";

/** The four tables that hold accounts / domains / aliases / admins. */
const ACCOUNT_TABLES = ["domain", "mailbox", "forwardings", "domain_admins"] as const;

/**
 * Every place a legacy install may keep amavis's editable config, shared with the
 * DKIM writer so a backup can't cover a narrower set of hosts than the thing it is
 * backing up. Hardcoding `/etc/amavis/conf.d/50-user` here meant a RHEL-family box
 * (monolithic `/etc/amavisd.conf`, no `conf.d`) produced a "keys" archive with no
 * amavis config in it at all — and said it succeeded.
 */
const AMAVIS_CONF_PATHS = HOST_AMAVIS_CONF_CANDIDATES.map((c) => c.path);

/** Debian-family location — the fallback when an archive doesn't name one. */
const AMAVIS_CONF_DEFAULT = HOST_AMAVIS_CONF_CANDIDATES[0].path;

/** Archive-relative name for the one amavis config we found, plus where it came from. */
const AMAVIS_IN_ARCHIVE = "keys/amavis-conf";

/** Pre-2026-08 archives stored the Debian path under this fixed name. */
const AMAVIS_IN_ARCHIVE_LEGACY = "keys/amavis-50-user";

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
  flavor: MailEngineFlavor,
): MailBackupPayload {
  const tableArgs = ACCOUNT_TABLES.map((t) => `-t ${t}`).join(" ");
  const truncateList = ACCOUNT_TABLES.join(", ");
  const info = JSON.stringify({ domain, messageData: flags.messageData, keys: flags.keys });

  const produceCommand = [
    "set -e",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    // Accounts + auth — always. Plain-SQL data-only dump (COPY blocks).
    `${mailPgDumpToStdout(flavor, `--data-only --no-owner --no-privileges ${tableArgs}`)} > "$tmp/vmail.data.sql"`,
    // What's inside — read by the UI / hand-restore.
    `printf '%s' '${info.replace(/'/g, "'\\''")}' > "$tmp/mail-backup.json"`,
    flags.keys
      ? [
          'mkdir -p "$tmp/keys"',
          // Every read here is `sudo -n`, and every copy is allowed to FAIL the backup.
          //
          // These are root-owned paths — `${HOST_STATE_DIR}` sits under /root (mode 0700)
          // and is itself created 0700, and /var/lib/dkim holds private keys. On a host
          // Openship logs into as a sudoer rather than as root, the old
          // `[ -f … ] && cp … || true` could not even stat them: the test failed for lack
          // of privilege, `|| true` absorbed it, and the run exited 0 having recorded
          // `keys: true` on an archive containing no keys. mail-state.json is the ONLY
          // copy of the DKIM state and the encrypted mailbox/admin credentials, so that
          // is a disaster-recovery archive which is silently not one. Same shape as the
          // amavis bug this file's own header documents.
          //
          // The `sudo -n` reads below only distinguish "absent" from "unreadable" if sudo
          // is known to WORK — otherwise a failing `test` reads as absence and skips, and
          // we are back to an archive stamped `keys: true` with no keys in it.
          //
          // That used to be guaranteed for free: `sudo -u postgres pg_dump` ran first, so
          // under `set -e` a box without sudo never reached here. Routing the dump through
          // the DB sidecar for containerized engines (GH-563) removed the guarantee on
          // exactly the topology most installs now use, so the probe is explicit. It is
          // the whole reason dropping `|| true` on the copies is safe.
          "sudo -n true",
          'if sudo -n test -d /var/lib/dkim; then sudo -n cp -a /var/lib/dkim "$tmp/keys/dkim"; fi',
          // Whichever of the known locations this box actually uses, with the source
          // path recorded alongside so the restore puts it back where amavis reads it.
          `for c in ${AMAVIS_CONF_PATHS.join(" ")}; do`,
          `  sudo -n test -f "$c" || continue`,
          `  sudo -n cp -a "$c" "$tmp/${AMAVIS_IN_ARCHIVE}"`,
          `  printf '%s' "$c" > "$tmp/${AMAVIS_IN_ARCHIVE}.path"`,
          `  break`,
          `done`,
          `if sudo -n test -f ${HOST_STATE_DIR}/mail-state.json; then`,
          `  sudo -n cp -a ${HOST_STATE_DIR}/mail-state.json "$tmp/keys/mail-state.json"`,
          `fi`,
        ].join("\n")
      : "",
    // Stream one tar to stdout: the staged dir + (optionally) the maildirs
    // read in place (not re-copied), so the source needs no extra disk.
    //
    // `sudo -n` for the same reason the staging above uses it, and it is not optional
    // here: `cp -a` as root stages root-owned 0600 files, so an unprivileged tar could not
    // read back what was just collected. /var/vmail is vmail:vmail 0700 and was already in
    // that position.
    //
    // The pipeline goes through the SHARED fragment so tar's status is no longer masked by
    // zstd's. The comment here used to describe that masking — "on a non-root login the
    // maildirs were being dropped from the artifact just as quietly" — and leave it in
    // place; this was the last pipeline in the module still carrying it. The fragment form
    // exists because this is one line of a `set -e` script rather than a standalone
    // `sh -c`, and it captures each status via `if` for exactly that reason.
    safePipelineFragment(
      flags.messageData
        ? 'sudo -n tar -c -C "$tmp" . -C /var/vmail vmail1'
        : 'sudo -n tar -c -C "$tmp" .',
      "zstd -c -3",
      { left: "tar (staging the mail archive)", right: "the compressor 'zstd'" },
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const restoreCommand = [
    "set -e",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    // stdin = the tar.zst artifact. Shared fragment again: a `zstd -d` that fails (a
    // truncated artifact, a missing binary) must not hide behind tar's status, because the
    // lines after this one TRUNCATE the account tables and then load from "$tmp" — so a
    // silently-empty extract would wipe the mail database and restore nothing.
    safePipelineFragment("zstd -d", 'tar -x -C "$tmp"', {
      left: "the decompressor 'zstd -d'",
      right: "tar (extracting the mail archive)",
    }),
    // Data-only restore: wipe the target's account tables, then load.
    `printf '%s' 'TRUNCATE ${truncateList} CASCADE;' | ${mailPsqlFromStdin(flavor)}`,
    `${mailPsqlFromStdin(flavor)} < "$tmp/vmail.data.sql"`,
    // DKIM keys + amavis config (if the archive carried them).
    'if [ -d "$tmp/keys/dkim" ]; then mkdir -p /var/lib/dkim && cp -a "$tmp/keys/dkim/." /var/lib/dkim/ || true; fi',
    // Where to put it is decided by THIS box, not by the box the archive came from.
    //
    // The archive records its source path, and honouring that verbatim restores a Debian
    // archive's /etc/amavis/conf.d/50-user onto a RHEL target, which reads a monolithic
    // /etc/amavisd.conf and never looks at the file we just wrote — restored, inert, and
    // `|| true` covering it. Cross-family is the NORMAL case here: the reason to restore
    // is usually a different machine. The recorded path only breaks the tie when the
    // target has no amavis at all, and is still matched against the known list rather
    // than trusted, because this shell runs as root on the target.
    //
    // The probe is each candidate's own `test`, which is the family detector the rest of
    // the system already uses — the first is keyed on the include DIRECTORY because
    // 50-user is ours to CREATE, so testing for the file would misread a Debian box that
    // has no override yet and fall through to the RHEL path. Deliberately NOT the
    // produce side's expression: collecting asks "is there a file to copy", placing asks
    // "which layout is this box".
    `dest=""`,
    ...HOST_AMAVIS_CONF_CANDIDATES.map(
      (c, i) => `${i === 0 ? "if" : "elif"} [ ${c.test} ]; then dest=${c.path}`,
    ),
    `fi`,
    `if [ -f "$tmp/${AMAVIS_IN_ARCHIVE}" ]; then`,
    `  saved="$(cat "$tmp/${AMAVIS_IN_ARCHIVE}.path" 2>/dev/null || true)"`,
    `  if [ -z "$dest" ]; then`,
    `    dest=${AMAVIS_CONF_DEFAULT}`,
    `    for c in ${AMAVIS_CONF_PATHS.join(" ")}; do if [ "$saved" = "$c" ]; then dest="$c"; break; fi; done`,
    `  fi`,
    `  cp -a "$tmp/${AMAVIS_IN_ARCHIVE}" "$dest" || true`,
    // Pre-2026-08 archives carried the Debian path under a fixed name, so they name no
    // source at all — which makes the target probe the only thing that can place them.
    `elif [ -f "$tmp/${AMAVIS_IN_ARCHIVE_LEGACY}" ]; then`,
    `  if [ -z "$dest" ]; then dest=${AMAVIS_CONF_DEFAULT}; fi`,
    `  cp -a "$tmp/${AMAVIS_IN_ARCHIVE_LEGACY}" "$dest" || true`,
    `fi`,
    // Maildirs (if included). Ownership must be vmail:vmail for Dovecot.
    // /var/vmail is a bind mount, so the COPY is a host operation either way - but the
    // ownership has to be applied where the `vmail` user exists, which on a containerized
    // box is the engine, not the host (GH-563). No `|| true` on the chown: maildirs left
    // root-owned are maildirs Dovecot cannot read, and swallowing that produced a restore
    // that reported success and served nothing.
    `if [ -d "$tmp/vmail1" ]; then cp -a "$tmp/vmail1" /var/vmail/ && ${mailEngineCommand(flavor, "chown -R vmail:vmail /var/vmail/vmail1")}; fi`,
    // Recompute per-domain counters (app-managed, not DB triggers).
    `printf '%s' "UPDATE domain d SET mailboxes=(SELECT count(*) FROM mailbox m WHERE m.domain=d.domain), aliases=(SELECT count(*) FROM forwardings f WHERE f.domain=d.domain AND f.is_alias) WHERE d.domain IS NOT NULL;" | ${mailPsqlFromStdin(flavor)} || true`,
    // Reload daemons so the restored data + keys take effect.
    `${mailDaemonReloadCommand(flavor)} || true`,
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
