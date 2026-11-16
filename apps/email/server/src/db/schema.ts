/**
 * SQLite app-state schema.
 *
 * The mail itself lives in IMAP on the mail server - Zero doesn't own
 * mail data. This DB holds the small amount of UI / preference state
 * Zero needs to remember between requests:
 *
 *   - session         encrypted IMAP credentials per active sign-in
 *   - user_settings   UI prefs (theme, signature, locale, etc.)
 *   - user_hotkeys    keyboard shortcut overrides
 *   - email_template  saved compose templates
 *   - cookie_consent  the GDPR-style consent banner choices
 *
 * Primary key is always the user's email address - there is no
 * separate user table. Sessions FK to email; deleting the session
 * row (sign-out) doesn't touch the prefs (they survive across
 * sign-ins).
 */

import { sqliteTable, text, integer, blob, primaryKey, index } from 'drizzle-orm/sqlite-core';
import type { UserSettings } from '../lib/schemas';
import type { ShortcutEntry } from '../lib/shortcuts';
import type { CookieConsent } from '../lib/cookies';

export const session = sqliteTable(
  'session',
  {
    /** Random session id; lives in the `zero_session` cookie. */
    id: text('id').primaryKey(),
    /** The full email address the user signed in with - that's the
     *  identity. There is no separate user table. */
    email: text('email').notNull(),
    /** Display name, pulled from IMAP server response if available. */
    name: text('name'),
    /** AES-GCM-encrypted IMAP password. Decrypted per request to open
     *  IMAP connections. Never stored in plaintext. */
    encryptedPassword: blob('encrypted_password', { mode: 'buffer' }).notNull(),
    /** IMAP host / port - derived from email domain at sign-in unless
     *  the env var overrides. Stored so we don't re-derive per request. */
    imapHost: text('imap_host').notNull(),
    imapPort: integer('imap_port').notNull(),
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull(),
    /** Unix-seconds epoch. */
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    /** Unix-seconds epoch - when the session must be re-validated. */
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_session_email').on(t.email), index('idx_session_expires_at').on(t.expiresAt)],
);

export const userSettings = sqliteTable('user_settings', {
  email: text('email').primaryKey(),
  settings: text('settings', { mode: 'json' }).$type<UserSettings>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const userHotkeys = sqliteTable(
  'user_hotkeys',
  {
    email: text('email').notNull(),
    /** Shortcut id (e.g. `mail.archive`). Composite key with email. */
    shortcutId: text('shortcut_id').notNull(),
    payload: text('payload', { mode: 'json' }).$type<ShortcutEntry>().notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.email, t.shortcutId] })],
);

export const emailTemplate = sqliteTable(
  'email_template',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    subject: text('subject'),
    body: text('body'),
    to: text('to', { mode: 'json' }).$type<string[] | null>(),
    cc: text('cc', { mode: 'json' }).$type<string[] | null>(),
    bcc: text('bcc', { mode: 'json' }).$type<string[] | null>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_email_template_email').on(t.email)],
);

export const cookieConsent = sqliteTable('cookie_consent', {
  email: text('email').primaryKey(),
  consent: text('consent', { mode: 'json' }).$type<CookieConsent>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Branding moved to a JSON file on disk - see [lib/branding.ts].
// Source of truth is `${BRANDING_PATH}/config.json`, seeded on first read and
// updated through `PATCH /admin/branding` (BRANDING_ADMIN_TOKEN). No SQLite row.

export const mailInstance = sqliteTable('mail_instance', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
});

export const mailGrant = sqliteTable(
  'mail_grant',
  {
    id: text('id').primaryKey(),
    mailboxId: text('mailbox_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    credentials: blob('credentials', { mode: 'buffer' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    internal: integer('internal', { mode: 'boolean' }).notNull().default(false),
    parentId: text('parent_id'),
  },
  (t) => [
    index('idx_mail_grant_mailbox').on(t.mailboxId),
    index('idx_mail_grant_expiry').on(t.expiresAt),
  ],
);

export const mailJob = sqliteTable(
  'mail_job',
  {
    id: text('id').primaryKey(),
    mailboxId: text('mailbox_id').notNull(),
    grantId: text('grant_id'),
    kind: text('kind', { enum: ['send', 'snooze'] }).notNull(),
    state: text('state', {
      enum: ['approval', 'pending', 'running', 'done', 'cancelled', 'failed', 'uncertain'],
    }).notNull(),
    revision: integer('revision').notNull().default(1),
    payload: blob('payload', { mode: 'buffer' }).notNull(),
    credentials: blob('credentials', { mode: 'buffer' }),
    dueAt: integer('due_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    error: text('error'),
  },
  (t) => [
    index('idx_mail_job_due').on(t.state, t.dueAt),
    index('idx_mail_job_mailbox').on(t.mailboxId),
    index('idx_mail_job_retention').on(t.state, t.updatedAt),
  ],
);

export const mailAssistant = sqliteTable('mail_assistant', {
  mailboxId: text('mailbox_id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  allowSend: integer('allow_send', { mode: 'boolean' }).notNull().default(false),
  chatId: text('chat_id').notNull(),
  history: blob('history', { mode: 'buffer' }).notNull(),
  activeRequest: text('active_request'),
  activeUntil: integer('active_until'),
  activeGrant: text('active_grant'),
  consentGrant: text('consent_grant'),
});

// Display metadata only. Mindwire owns provider secrets inside the mailbox runtime.
export const mailAssistantConnection = sqliteTable('mail_assistant_connection', {
  mailboxId: text('mailbox_id').primaryKey(),
  agent: text('agent', { enum: ['codex', 'claude-code'] }).notNull(),
  name: text('name').notNull(),
  model: text('model'),
  customProvider: text('custom_provider'),
});
