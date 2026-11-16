/**
 * Per-request context.
 *
 * Built once at the start of each tRPC / Hono request from the
 * session cookie. The IMAP/SMTP auth objects are derived once here so
 * route code can hand them straight to the driver without re-reading
 * the session row.
 *
 * The raw `Context` from Hono is forwarded too so a handful of routes
 * (account switcher, sign-out fall-through) can read the secondary
 * `zero_sessions` cookie without re-implementing cookie parsing.
 */

import type { Context as HonoContext } from 'hono';
import type { SessionContext } from './lib/session';
import type { ImapAuth } from './lib/imap';
import type { SmtpAuth } from './lib/smtp';
import { mailboxAuth } from './mail/identity';

export interface AppContext {
  session: SessionContext | null;
  imap: ImapAuth | null;
  smtp: SmtpAuth | null;
  hono: HonoContext | null;
}

export function buildContext(
  session: SessionContext | null,
  hono: HonoContext | null = null,
): AppContext {
  if (!session) return { session: null, imap: null, smtp: null, hono };
  return {
    session,
    ...mailboxAuth(session),
    hono,
  };
}
