/**
 * Zod schemas + shared types for user preferences.
 *
 * `defaultUserSettings` is the source of truth for what a fresh
 * `user_settings.settings` blob looks like. The client re-uses this
 * via `@zero/server/schemas` so both sides agree on the shape.
 */

import { z } from 'zod';

export const userSettingsSchema = z.object({
  language: z.string().default('en'),
  timezone: z.string().default('UTC'),
  dynamicContent: z.boolean().default(false),
  externalImages: z.boolean().default(true),
  trustedSenders: z.array(z.string()).default([]),
  isOnboarded: z.boolean().default(false),
  colorTheme: z.enum(['light', 'dark', 'system']).default('system'),
  inboxType: z.enum(['default', 'important-first', 'unread-first']).default('default'),
  signature: z.string().default(''),
  zeroSignature: z.boolean().default(true),
  undoSendTime: z.number().int().min(0).max(30).default(5),
  customPrompt: z.string().default(''),
  autoRead: z.boolean().default(false),
  noteFolderId: z.string().nullable().default(null),
  defaultEmailAlias: z.string().default(''),
  undoSendEnabled: z.boolean().default(true),
  animations: z.boolean().default(true),
  imageCompression: z.boolean().default(true),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const defaultUserSettings: UserSettings = userSettingsSchema.parse({});

/**
 * Sign-in input - STRICT. Only the credentials.
 *
 * We deliberately do NOT accept imapHost / imapPort / smtpHost /
 * smtpPort from the client. Each Zero deployment serves exactly one
 * mail backend (the box it's installed alongside), so allowing the
 * browser to override the host turns sign-in into a credential
 * exfiltration channel - an attacker can post a phishing link that
 * sends the victim's password to an attacker-controlled IMAP server.
 * Hosts come from server env (DEFAULT_IMAP_HOST/DEFAULT_SMTP_HOST)
 * and from `defaultMailHosts(email)` only.
 */
export const signInSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();

export type SignInInput = z.infer<typeof signInSchema>;
