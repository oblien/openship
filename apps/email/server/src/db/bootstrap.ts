/**
 * Schema bootstrap - `CREATE TABLE IF NOT EXISTS` for every app-state
 * table at server startup.
 *
 * Why not `drizzle-kit migrate`:
 *   - This is a self-hosted app. Operators don't run `bun db:migrate`
 *     between releases; they pull, restart, and expect it to work.
 *   - There's no destructive migration story here (the schema is
 *     append-only - Zero doesn't own mail data, just session + UI
 *     prefs that are cheap to recreate if the file gets nuked).
 *   - One file < a `./migrations` directory full of SQL files
 *     that have to stay in lockstep with `schema.ts`.
 *
 * If you change `schema.ts`:
 *   - Adding a table → add another `CREATE TABLE IF NOT EXISTS` here.
 *   - Adding a column → inspect PRAGMA table_info before ALTER TABLE.
 *   - Renaming/dropping → write a one-shot migration in here gated
 *     by a `PRAGMA user_version` bump.
 *
 * `IF NOT EXISTS` everywhere keeps this idempotent so it runs at every
 * boot with zero observable cost on already-bootstrapped DBs.
 */

import type { Database } from 'bun:sqlite';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mail_assistant_connection (
    mailbox_id TEXT PRIMARY KEY, agent TEXT NOT NULL, name TEXT NOT NULL,
    model TEXT, custom_provider TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS mail_instance (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mail_grant (
    id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, credentials BLOB,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
    internal INTEGER NOT NULL DEFAULT 0, parent_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mail_grant_mailbox ON mail_grant(mailbox_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mail_grant_expiry ON mail_grant(expires_at)`,
  `CREATE TABLE IF NOT EXISTS mail_job (
    id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, grant_id TEXT,
    kind TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    payload BLOB NOT NULL, credentials BLOB, due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mail_job_due ON mail_job(state, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mail_job_retention ON mail_job(state, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mail_job_mailbox ON mail_job(mailbox_id)`,
  `CREATE TABLE IF NOT EXISTS mail_assistant (
    mailbox_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, allow_send INTEGER NOT NULL DEFAULT 0,
    chat_id TEXT NOT NULL, history BLOB NOT NULL, active_request TEXT, active_until INTEGER, active_grant TEXT, consent_grant TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    encrypted_password BLOB NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_email ON session(email)`,
  `CREATE INDEX IF NOT EXISTS idx_session_expires_at ON session(expires_at)`,

  `CREATE TABLE IF NOT EXISTS user_settings (
    email TEXT PRIMARY KEY,
    settings TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS user_hotkeys (
    email TEXT NOT NULL,
    shortcut_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (email, shortcut_id)
  )`,

  `CREATE TABLE IF NOT EXISTS email_template (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    "to" TEXT,
    cc TEXT,
    bcc TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_template_email ON email_template(email)`,

  `CREATE TABLE IF NOT EXISTS cookie_consent (
    email TEXT PRIMARY KEY,
    consent TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

export function bootstrapSchema(sqlite: Database): void {
  for (const sql of STATEMENTS) {
    sqlite.exec(sql);
  }
}
