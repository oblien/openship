/**
 * Auth endpoints - multi-account aware.
 *
 *   POST /auth/sign-in     { email, password } → adds to session list, makes active
 *   POST /auth/sign-out    → drops THIS session, falls back to another if any
 *   POST /auth/switch      { sessionId }       → just changes which one is active
 *   GET  /auth/session     → active session JSON (or null)
 *   GET  /auth/sessions    → ALL sessions on this browser (for the account switcher)
 *
 * Two cookies:
 *   `zero_session`  - the active session id (one mailbox is "current")
 *   `zero_sessions` - comma-separated list of every session id this browser
 *                     is signed in to. Lets us render the switcher and let
 *                     sign-out fall back instead of kicking the user to /login.
 *
 * There is no separate user table - the IMAP server is the identity
 * provider. A "connection" === a session row.
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { activateSession, clearActiveCookies, clearSessionCookies, readActiveSessionId, readLiveSessionIds } from '../lib/session-cookies';
import { env } from '../env';
import { signInSchema } from '../lib/schemas';
import { probeImap } from '../lib/imap';
import { classifyImapFailure } from '../lib/imap-errors';
import { saveSession, deleteSession, defaultMailHosts, getSession } from '../lib/session';
import { db, schema } from '../db';
import { eq, inArray } from 'drizzle-orm';
import { createRateLimiter } from '../lib/rate-limit';
import { audit } from '../lib/audit-log';
import { permitsBrowserOrigin } from '../lib/request-origin';
import { clientIp } from '../lib/client-ip';

export const authRoutes = new Hono();
authRoutes.use('*', async (c, next) => {
  if (c.req.method === 'POST' && !permitsBrowserOrigin(c)) return c.json({ error: 'Origin not allowed' }, 403);
  return next();
});

// Two complementary rate limits on sign-in:
//   - per-IP: stops one host from grinding through guesses.
//   - per-email: catches distributed credential stuffing where each
//     attempt comes from a fresh IP but targets the same mailbox.
// In-memory, fixed-window - fine for the single-process Bun deploy.
const signInIpLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 5 });
const signInEmailLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

function rateLimited(c: any, retryAfter: number) {
  c.header('Retry-After', String(retryAfter));
  return c.json({ error: 'Too many requests' }, 429);
}

authRoutes.post('/sign-in', async (c) => {
  const ip = clientIp(c);
  // IP bucket is checked first - it doesn't need the body parsed. If a
  // single host is grinding requests, we cut it off before doing any
  // database or IMAP work.
  const ipHit = signInIpLimiter.hit(ip);
  if (!ipHit.ok) {
    audit({ event: 'rate-limit', ok: false, ip, reason: 'ip-limit' });
    return rateLimited(c, ipHit.retryAfter);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = signInSchema.safeParse(body);
  if (!parsed.success) {
    audit({ event: 'sign-in', ok: false, ip, reason: 'invalid-input' });
    return c.json({ error: 'Invalid input' }, 400);
  }

  const lcEmail = parsed.data.email.toLowerCase();

  // Email bucket catches distributed brute-force where each attempt
  // ships from a different IP but targets the same mailbox. Counts
  // BEFORE we probe - we don't want the attacker to learn whether the
  // mailbox exists by timing.
  const emailHit = signInEmailLimiter.hit(lcEmail);
  if (!emailHit.ok) {
    audit({ event: 'rate-limit', ok: false, ip, email: lcEmail, reason: 'email-limit' });
    return rateLimited(c, emailHit.retryAfter);
  }

  // Hosts are server-side only - see schemas.ts for the rationale.
  const { imapHost, imapPort, smtpHost, smtpPort } = defaultMailHosts(
    parsed.data.email,
  );

  let ok: boolean;
  try {
    ok = await probeImap({
      host: imapHost,
      port: imapPort,
      user: parsed.data.email,
      pass: parsed.data.password,
    });
  } catch (error) {
    const failure = classifyImapFailure(error);
    // Never log the raw IMAP response/command: it can contain credentials.
    audit({ event: 'sign-in', ok: false, ip, email: lcEmail, reason: `imap-${failure}` });
    const message = failure === 'tls'
      ? 'Webmail could not establish a secure connection to the mail server. Contact your administrator.'
      : failure === 'connection'
        ? 'Webmail cannot reach the mail server. Try again shortly or contact your administrator.'
        : 'The mail server could not complete sign-in. Try again shortly or contact your administrator.';
    return c.json({ error: message, code: 'MAIL_SERVER_UNAVAILABLE' }, 503);
  }
  if (!ok) {
    audit({ event: 'sign-in', ok: false, ip, email: lcEmail, reason: 'invalid-credentials' });
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // If a session for this email already exists in our cookie list, reuse it
  // instead of creating a duplicate row. Refresh the verified credentials too:
  // retaining an old password or backend makes the next mailbox request fail.
  const existingIds = await readLiveSessionIds(c);
  const existingRows = existingIds.length
    ? await db.query.session.findMany({
        where: inArray(schema.session.id, existingIds),
        columns: { id: true, email: true, expiresAt: true },
      })
    : [];
  const existing = existingRows.find((r) => r.email === lcEmail);

  const { id: activeId, expiresAt: activeExpiresAt } = await saveSession({
    email: parsed.data.email,
    name: parsed.data.name,
    password: parsed.data.password,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
  }, existing?.id);
  await activateSession(c, activeId, activeExpiresAt, existingIds);
  // Clear the per-email failure bucket on success - otherwise a user who
  // mistyped a few times would stay penalised after recovering.
  signInEmailLimiter.reset(lcEmail);
  audit({ event: 'sign-in', ok: true, ip, email: lcEmail, sessionId: activeId });
  return c.json({ ok: true, email: parsed.data.email, sessionId: activeId });
});

authRoutes.post('/sign-out', async (c) => {
  const ip = clientIp(c);
  const sid = await readActiveSessionId(c);
  if (sid) await deleteSession(sid);
  audit({ event: 'sign-out', ok: true, ip, sessionId: sid });

  // Drop this id from the list and either fall back to whichever session
  // is next, or clear both cookies so the client lands on /login.
  const liveIds = (await readLiveSessionIds(c)).filter((id) => id !== sid);

  if (liveIds.length === 0) {
    clearSessionCookies(c);
    return c.json({ ok: true, nextSessionId: null });
  }

  const next = await db.query.session.findFirst({
    where: eq(schema.session.id, liveIds[0]),
    columns: { id: true, expiresAt: true, email: true },
  });
  if (!next) {
    // Shouldn't happen - readLiveSessionIds filters out dead rows - but
    // play it safe.
    clearSessionCookies(c);
    return c.json({ ok: true, nextSessionId: null });
  }

  await activateSession(c, next.id, next.expiresAt, liveIds);
  return c.json({ ok: true, nextSessionId: next.id, nextEmail: next.email });
});

// Just change which signed-in session is active. No re-auth, no IMAP probe;
// the row + encrypted password were already created on the original sign-in.
authRoutes.post('/switch', async (c) => {
  const ip = clientIp(c);
  const body = await c.req.json().catch(() => null) as { sessionId?: unknown } | null;
  const target = typeof body?.sessionId === 'string' ? body.sessionId : null;
  if (!target) {
    audit({ event: 'switch', ok: false, ip, reason: 'missing-session-id' });
    return c.json({ error: 'sessionId required' }, 400);
  }

  const liveIds = await readLiveSessionIds(c);
  if (!liveIds.includes(target)) {
    // Caller asked to switch to a session that isn't in their cookie
    // - could be a stale ID or a CSRF-y probe. Either way: deny + log.
    audit({ event: 'switch', ok: false, ip, sessionId: target, reason: 'not-in-cookie' });
    return c.json({ error: 'Unknown session' }, 404);
  }

  const row = await db.query.session.findFirst({
    where: eq(schema.session.id, target),
    columns: { id: true, expiresAt: true, email: true },
  });
  if (!row) {
    audit({ event: 'switch', ok: false, ip, sessionId: target, reason: 'not-in-db' });
    return c.json({ error: 'Unknown session' }, 404);
  }

  await activateSession(c, row.id, row.expiresAt, liveIds);
  audit({ event: 'switch', ok: true, ip, email: row.email, sessionId: row.id });
  return c.json({ ok: true, email: row.email });
});

authRoutes.get('/session', async (c) => {
  const sid = await readActiveSessionId(c);
  if (!sid) {
    if (getCookie(c, env.SESSION_COOKIE_NAME)) clearActiveCookies(c);
    return c.json(null);
  }
  const session = await getSession(sid);
  if (!session) {
    // Cookie present but the row is gone (expired & swept, DB reset, prior
    // deploy wiped state). Without an explicit delete the browser keeps
    // resending the dead id on every request - and on multi-cookie shadow
    // jars the dead id is the FIRST match, so the user loops to /login
    // forever. Evict it here so the next request hits the !sid branch and
    // /login can do a clean reauth.
    clearActiveCookies(c);
    return c.json(null);
  }
  return c.json({
    email: session.email,
    name: session.name,
    expiresAt: session.expiresAt.toISOString(),
  });
});

// Returns metadata for every session the browser is signed into. This is
// what powers the account switcher in the sidebar - the client never needs
// to know how the cookie is shaped.
authRoutes.get('/sessions', async (c) => {
  const activeId = await readActiveSessionId(c);
  const liveIds = await readLiveSessionIds(c);
  if (!liveIds.length) return c.json({ sessions: [], activeId: null });
  const rows = await db.query.session.findMany({
    where: inArray(schema.session.id, liveIds),
    columns: { id: true, email: true, name: true, expiresAt: true },
  });
  // Preserve the cookie-list order so the UI feels stable.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sessions = liveIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      expiresAt: r.expiresAt.toISOString(),
    }));
  return c.json({ sessions, activeId: activeId ?? null });
});
