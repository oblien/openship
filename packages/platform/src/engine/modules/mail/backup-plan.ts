/** Mail's archive layout; capture, restore and migration share this one plan. */
import { HOST_STATE_DIR, safePipelineFragment } from "@repo/adapters";
import { shellQuote } from "@repo/core";
import {
  HOST_AMAVIS_CONF_CANDIDATES,
  mailDaemonReloadCommand,
  mailEngineCommand,
  mailHostPath,
  mailPgDumpToStdout,
  mailPsqlFromStdin,
  mailPsqlCommand,
  type MailEngineFlavor,
} from "./mail-engine";

export interface MailBackupFlags {
  messageData: boolean;
  keys: boolean;
}
export function mailBackupFlags(config: unknown): MailBackupFlags {
  const mail = (config as { mail?: Partial<MailBackupFlags> } | null)?.mail;
  return { messageData: mail?.messageData !== false, keys: mail?.keys !== false };
}

export interface MailBackupPayload {
  /** Required-file checks, repeated at capture to guard against later changes. */
  preflightCommand: string;
  payloadKind: "custom_command";
  payloadConfig: {
    produceCommand: string;
    restoreCommand: string;
    artifactName: string;
    mail: MailBackupFlags & { version: 2 };
  };
}
export interface MailBackupPlanOptions {
  /** A root-only portable state file prepared by the shared mail lifecycle. */
  statePath?: string;
  /** A root-only handoff consumed and removed by restore finalization. */
  restoreStatePath?: string;
}

// These databases belong to the mail stack (db-bootstrap.sh). Never dump
// unrelated application/control-plane databases from a shared host cluster.
const AUXILIARY_DATABASES = ["amavisd", "iredapd", "fail2ban"] as const;
const dumpFlags = "--clean --if-exists --no-owner";
// Postfix queue data, excluding target-specific chroot libraries, sockets and PID files.
const QUEUE_DIRECTORIES =
  "active bounce corrupt defer deferred flush hold incoming maildrop saved trace";
// iRedMail uses these Amavis roots on supported Debian/Ubuntu and RHEL hosts.
const amavisRoot =
  'if [ -d /var/lib/amavis ]; then root=/var/lib/amavis; elif [ -d /var/spool/amavisd ]; then root=/var/spool/amavisd; else echo "Mail filter storage not found" >&2; exit 1; fi';
const amavisDataNames = "db quarantine virusmails .spamassassin";

export function buildMailBackupPayload(
  domain: string,
  flags: MailBackupFlags,
  flavor: MailEngineFlavor = "host",
  options: MailBackupPlanOptions = {},
): MailBackupPayload {
  const maildir = mailHostPath(flavor, "/var/vmail");
  const dkim = mailHostPath(flavor, "/var/lib/dkim");
  const amavisPaths =
    flavor === "container"
      ? [mailHostPath(flavor, "/etc/amavis/conf.d/50-user")]
      : HOST_AMAVIS_CONF_CANDIDATES.map((candidate) => candidate.path);
  const statePath = options.statePath ?? `${HOST_STATE_DIR}/mail-state.json`;
  const preflight = [
    "set -eu",
    ...(flags.keys
      ? [
          `test -d ${shellQuote(dkim)}`,
          `test -s ${shellQuote(`${dkim}/${domain}.pem`)} || { echo "The mail server's primary DKIM key is missing or unreadable" >&2; exit 1; }`,
          `test -s ${shellQuote(statePath)}`,
        ]
      : []),
    ...(flags.messageData ? [`test -d ${shellQuote(maildir)}`] : []),
  ].join("\n");
  const info = JSON.stringify({ version: 2, domain, ...flags, portableState: !!options.statePath });
  const produce = [
    "set -eu",
    "umask 077",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    'stage="$tmp/staging"',
    'mkdir -p "$stage"',
    preflight,
    `${mailPgDumpToStdout(flavor, dumpFlags)} > "$stage/vmail.sql"`,
    'mkdir -p "$stage/databases"',
    ...AUXILIARY_DATABASES.map((db) =>
      [
        `if [ "$(${mailPsqlCommand(flavor, `SELECT 1 FROM pg_database WHERE datname='${db}'`)})" = 1 ]; then`,
        `  ${mailPgDumpToStdout(flavor, dumpFlags, db)} > "$stage/databases/${db}.sql"`,
        "fi",
      ].join("\n"),
    ),
    `printf '%s' ${shellQuote(info)} > "$stage/mail-backup.json"`,
    flags.keys
      ? [
          'mkdir -p "$stage/keys"',
          `cp -a ${shellQuote(dkim)} "$stage/keys/dkim"`,
          `for c in ${amavisPaths.map(shellQuote).join(" ")}; do`,
          '  [ -f "$c" ] || continue',
          '  cp -a "$c" "$stage/keys/amavis-conf"',
          '  printf \'%s\' "$c" > "$stage/keys/amavis-conf.path"',
          "  break",
          "done",
          `cp -a ${shellQuote(statePath)} "$stage/keys/mail-state.json"`,
        ].join("\n")
      : "",
    ...(flags.messageData
      ? [
          `${mailEngineCommand(flavor, `tar -c -C /var/spool/postfix ${QUEUE_DIRECTORIES}`)} > "$stage/postfix.tar"`,
          `${mailEngineCommand(flavor, `sh -c ${shellQuote(`${amavisRoot}; cd "$root"; for name in ${amavisDataNames}; do if [ -d "$name" ]; then printf '%s\\n' "$name"; fi; done | tar -c -T -`)}`)} > "$stage/amavis.tar"`,
        ]
      : []),
    safePipelineFragment(
      flags.messageData
        ? `tar -c --transform=${shellQuote("flags=rh;s#^\\.$#vmail#;s#^\\./#vmail/#;s#^staging/#./#")} -C "$tmp" staging -C ${shellQuote(maildir)} .`
        : 'tar -c -C "$stage" .',
      "zstd -c -3",
      { left: "tar (staging the mail archive)", right: "the compressor 'zstd'" },
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const restore = [
    "set -eu",
    "umask 077",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    safePipelineFragment("zstd -d", 'tar -x -C "$tmp"', {
      left: "the decompressor 'zstd -d'",
      right: "tar (extracting the mail archive)",
    }),
    // Refuse an empty or unrelated archive before touching live data.
    '[ -s "$tmp/vmail.sql" ] && [ -s "$tmp/mail-backup.json" ] || { echo "Invalid mail backup: required data is missing" >&2; exit 1; }',
    flags.keys && options.restoreStatePath
      ? '[ -s "$tmp/keys/mail-state.json" ] || { echo "Mail backup has no portable configuration" >&2; exit 1; }'
      : "",
    flags.messageData
      ? '[ -d "$tmp/vmail" ] && [ -s "$tmp/postfix.tar" ] && [ -s "$tmp/amavis.tar" ] || { echo "Mail backup has no message store or queue" >&2; exit 1; }'
      : "",
    ...(flags.messageData
      ? ['tar -tf "$tmp/postfix.tar" > /dev/null', 'tar -tf "$tmp/amavis.tar" > /dev/null']
      : []),
    // Each database's schema and rows restore in one transaction. Roles and
    // their passwords stay on the destination; the dump retains mail grants.
    ...AUXILIARY_DATABASES.map(
      (db) =>
        `if [ -f "$tmp/databases/${db}.sql" ]; then ${mailPsqlFromStdin(flavor, { singleTransaction: true, database: db })} < "$tmp/databases/${db}.sql"; fi`,
    ),
    `${mailPsqlFromStdin(flavor, { singleTransaction: true })} < "$tmp/vmail.sql"`,
    `if [ -d "$tmp/keys/dkim" ]; then mkdir -p ${shellQuote(dkim)}; cp -a "$tmp/keys/dkim/." ${shellQuote(dkim)}/; fi`,
    // The destination's own mail configuration/DB credentials stay authoritative.
    // Finalization reuses normal DKIM/relay primitives after the data is restored.
    options.restoreStatePath
      ? [
          'if [ -f "$tmp/keys/mail-state.json" ]; then',
          `  install -m 0600 "$tmp/keys/mail-state.json" ${shellQuote(options.restoreStatePath)}`,
          "fi",
        ].join("\n")
      : "",
    flags.messageData
      ? [
          // Keep bind-mount roots in place so the engine observes the replacement.
          `find -H ${shellQuote(maildir)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
          `cp -a "$tmp/vmail/." ${shellQuote(maildir)}/`,
          mailEngineCommand(flavor, "chown -R -H vmail:vmail /var/vmail"),
          `${mailEngineCommand(flavor, `sh -c ${shellQuote(`set -eu; for name in ${QUEUE_DIRECTORIES}; do find "/var/spool/postfix/$name" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; done; tar -x --same-owner -C /var/spool/postfix`)}`, { stdin: true })} < "$tmp/postfix.tar"`,
          `${mailEngineCommand(flavor, `sh -c ${shellQuote(`set -eu; ${amavisRoot}; for name in ${amavisDataNames}; do if [ -d "$root/$name" ]; then find "$root/$name" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi; done; tar -x --same-owner -C "$root"`)}`, { stdin: true })} < "$tmp/amavis.tar"`,
          mailEngineCommand(flavor, "postsuper -s"),
        ].join("\n")
      : "",
    options.restoreStatePath ? "" : mailDaemonReloadCommand(flavor),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    preflightCommand: `sudo -n sh -c ${shellQuote(preflight)}`,
    payloadKind: "custom_command",
    payloadConfig: {
      produceCommand: `sudo -n sh -c ${shellQuote(produce)}`,
      restoreCommand: `sudo -n sh -c ${shellQuote(restore)}`,
      artifactName: "mail.tar.zst",
      mail: { version: 2, ...flags },
    },
  };
}
