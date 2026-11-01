/**
 * Session lookup, create, and delete helpers.
 *
 * A session in Zero is the *identity* - the mailbox itself. There is
 * no separate user table. A row in `session` represents one active
 * sign-in: it holds the encrypted IMAP password and the IMAP/SMTP
 * coordinates so we can open connections per request without asking
 * the user to re-authenticate.
 *
 * `getSession()` is what middleware calls; it returns the row plus a
 * decrypted password ready for `withImap` / `sendMail`.
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db';
import { encryptSecret, decryptSecret } from './crypto';
import { env } from '../env';

export interface SessionContext {
  sessionId: string;
  email: string;
  name: string | null;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  expiresAt: Date;
}

/** Persist credentials only after a successful IMAP sign-in, in one write. */
export async function saveSession(opts: {
  email: string;
  name?: string | null;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}, existingId?: string): Promise<{ id: string; expiresAt: Date }> {
  const id = existingId ?? nanoid(40);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.SESSION_TTL_SECONDS * 1000);
  const values = {
    email: opts.email.toLowerCase(),
    name: opts.name,
    encryptedPassword: encryptSecret(opts.password),
    imapHost: opts.imapHost,
    imapPort: opts.imapPort,
    smtpHost: opts.smtpHost,
    smtpPort: opts.smtpPort,
    expiresAt,
  };
  if (existingId) {
    // Re-authentication must refresh the password AND backend together. An
    // omitted display name leaves the existing one intact (Drizzle skips it).
    const updated = await db.update(schema.session).set(values).where(and(
      eq(schema.session.id, id), eq(schema.session.email, values.email),
    )).returning({ id: schema.session.id });
    if (!updated.length) throw new Error('The session changed during sign-in. Please sign in again.');
  } else {
    await db.insert(schema.session).values({ id, ...values, name: opts.name ?? null, createdAt: now });
  }
  return { id, expiresAt };
}

export async function getSession(sessionId: string): Promise<SessionContext | null> {
  const row = await db.query.session.findFirst({
    where: eq(schema.session.id, sessionId),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await deleteSession(sessionId);
    return null;
  }
  return {
    sessionId: row.id,
    email: row.email,
    name: row.name,
    password: decryptSecret(row.encryptedPassword as Buffer),
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    expiresAt: row.expiresAt,
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(schema.session).where(eq(schema.session.id, sessionId));
}

/**
 * Derives IMAP/SMTP coordinates for an email address. If the env var
 * overrides are set, use them - otherwise guess `mail.<domain>`.
 *
 * This is the convention iRedMail installs out of the box, and is the
 * shape Openship's mail panel provisions. Backend overrides are server-side;
 * the sign-in endpoint accepts credentials only.
 */
export function defaultMailHosts(email: string): {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
} {
  const domain = email.split('@')[1] ?? '';
  return {
    imapHost: env.DEFAULT_IMAP_HOST ?? `mail.${domain}`,
    imapPort: env.DEFAULT_IMAP_PORT,
    smtpHost: env.DEFAULT_SMTP_HOST ?? `mail.${domain}`,
    smtpPort: env.DEFAULT_SMTP_PORT,
  };
}
