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
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { env } from '../env';
import { signInSchema } from '../lib/schemas';
import { probeImap } from '../lib/imap';
import { createSession, deleteSession, defaultMailHosts, getSession } from '../lib/session';
import { db, schema } from '../db';
import { eq, inArray } from 'drizzle-orm';
import { createRateLimiter } from '../lib/rate-limit';
import { audit } from '../lib/audit-log';
import { clientIp } from '../lib/client-ip';

export const authRoutes = new Hono();

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

/**
 * Session cookies are HOST-ONLY (no Domain attribute) on purpose.
 *
 * RFC 6265 §5.3: a same-named cookie pinned to a different Domain is a
 * SEPARATE jar entry, not a replacement. Earlier builds set a Domain
 * attribute (or set the cookie host-only when COOKIE_DOMAIN was
 * undefined), and any browser that visited then still holds a shadow
 * cookie at the wider scope. Hono's cookie parser returns the FIRST
 * match and breaks - so the stale shadow wins, the server can't find
 * its row, and the user gets bounced to /login on every navigation
 * until they manually clear the jar. Pinning to host-only here makes
 * "the cookie I just wrote" the only cookie the browser ships back.
 *
 * `evictShadowCookies` below handles users who already have a wide-
 * scope shadow from a previous build - every sign-in evicts the known
 * historical scopes so they don't outlive the next successful login.
 */
const COOKIE_OPTS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'Lax' as const,
  path: '/',
};

// Non-httpOnly companion of the active session cookie. The client reads
// this synchronously at boot to namespace its persisted (IDB) query cache
// per user. The value is just a session id - not a credential - so XSS
// reading it isn't worse than the attacker just making authenticated
// requests directly (cookies are sent with credentials:'include').
const ACTIVE_ID_COOKIE_NAME = `${env.SESSION_COOKIE_NAME}_id`;
const PUBLIC_COOKIE_OPTS = { ...COOKIE_OPTS, httpOnly: false };

const LIST_COOKIE_NAME = `${env.SESSION_COOKIE_NAME}s`;

/**
 * Evict any same-name session cookies pinned to wider scopes by previous
 * builds (Domain=<host>, Domain=<apex>, Domain=.<apex>) so they don't
 * shadow the fresh host-only cookie we're about to write. Each scope
 * needs its own `Set-Cookie: name=; Max-Age=0` because browsers only
 * remove a cookie when the (name, Domain, Path) triple matches.
 *
 * Cheap (a few extra Set-Cookie headers) and idempotent - safe to call
 * on every login. Users who never had a wide-scope cookie just receive
 * a couple of no-op deletes; users who did get their loop unstuck.
 */
function evictShadowCookies(c: any) {
  const configured = env.COOKIE_DOMAIN;
  const scopes: Array<{ domain?: string }> = [];
  if (configured && configured !== 'localhost') {
    scopes.push({ domain: configured });
    scopes.push({ domain: `.${configured}` });
    if (configured.includes('.')) {
      const apex = configured.split('.').slice(-2).join('.');
      if (apex !== configured) {
        scopes.push({ domain: apex });
        scopes.push({ domain: `.${apex}` });
      }
    }
  }
  for (const scope of scopes) {
    for (const name of [env.SESSION_COOKIE_NAME, ACTIVE_ID_COOKIE_NAME, LIST_COOKIE_NAME]) {
      deleteCookie(c, name, { path: '/', ...scope });
    }
  }
}

function setActiveCookies(c: any, sessionId: string, expiresAt: Date) {
  evictShadowCookies(c);
  setCookie(c, env.SESSION_COOKIE_NAME, sessionId, { ...COOKIE_OPTS, expires: expiresAt });
  setCookie(c, ACTIVE_ID_COOKIE_NAME, sessionId, {
    ...PUBLIC_COOKIE_OPTS,
    expires: expiresAt,
  });
}

function clearActiveCookies(c: any) {
  evictShadowCookies(c);
  deleteCookie(c, env.SESSION_COOKIE_NAME, COOKIE_OPTS);
  deleteCookie(c, ACTIVE_ID_COOKIE_NAME, PUBLIC_COOKIE_OPTS);
}

// Parse the multi-session cookie, dedupe, and drop ids whose rows no
// longer exist (expired/deleted). Returns the surviving list, freshest
// first.
async function readLiveSessionIds(raw: string | undefined): Promise<string[]> {
  if (!raw) return [];
  const ids = Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  if (!ids.length) return [];
  const rows = await db.query.session.findMany({
    where: inArray(schema.session.id, ids),
    columns: { id: true, expiresAt: true },
  });
  const now = Date.now();
  const alive = new Set(
    rows.filter((r) => r.expiresAt.getTime() > now).map((r) => r.id),
  );
  return ids.filter((id) => alive.has(id));
}

function writeSessionListCookie(c: any, ids: string[], expiresAt?: Date) {
  if (ids.length === 0) {
    deleteCookie(c, LIST_COOKIE_NAME, COOKIE_OPTS);
    return;
  }
  setCookie(c, LIST_COOKIE_NAME, ids.join(','), {
    ...COOKIE_OPTS,
    // Use the longest TTL of any active session; we don't track per-id
    // expiry on this cookie, only the membership.
    expires: expiresAt ?? new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000),
  });
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

  const ok = await probeImap({
    host: imapHost,
    port: imapPort,
    user: parsed.data.email,
    pass: parsed.data.password,
  });
  if (!ok) {
    audit({ event: 'sign-in', ok: false, ip, email: lcEmail, reason: 'invalid-credentials' });
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // If a session for this email already exists in our cookie list, reuse it
  // instead of creating a duplicate row. Sign-in then degenerates into a
  // "switch" - same connection id, refreshed cookie.
  const existingIds = await readLiveSessionIds(getCookie(c, LIST_COOKIE_NAME));
  const existingRows = existingIds.length
    ? await db.query.session.findMany({
        where: inArray(schema.session.id, existingIds),
        columns: { id: true, email: true, expiresAt: true },
      })
    : [];
  const existing = existingRows.find((r) => r.email === lcEmail);

  let activeId: string;
  let activeExpiresAt: Date;
  let liveIds: string[];

  if (existing) {
    if (parsed.data.name !== undefined) {
      await db.update(schema.session).set({ name: parsed.data.name }).where(eq(schema.session.id, existing.id));
    }
    activeId = existing.id;
    activeExpiresAt = existing.expiresAt;
    liveIds = [existing.id, ...existingIds.filter((id) => id !== existing.id)];
  } else {
    const created = await createSession({
      email: parsed.data.email,
      name: parsed.data.name ?? null,
      password: parsed.data.password,
      imapHost,
      imapPort,
      smtpHost,
      smtpPort,
    });
    activeId = created.id;
    activeExpiresAt = created.expiresAt;
    liveIds = [created.id, ...existingIds];
  }

  setActiveCookies(c, activeId, activeExpiresAt);
  writeSessionListCookie(c, liveIds, activeExpiresAt);
  // Clear the per-email failure bucket on success - otherwise a user who
  // mistyped a few times would stay penalised after recovering.
  signInEmailLimiter.reset(lcEmail);
  audit({ event: 'sign-in', ok: true, ip, email: lcEmail, sessionId: activeId });
  return c.json({ ok: true, email: parsed.data.email, sessionId: activeId });
});

authRoutes.post('/sign-out', async (c) => {
  const ip = clientIp(c);
  const sid = getCookie(c, env.SESSION_COOKIE_NAME);
  if (sid) await deleteSession(sid);
  audit({ event: 'sign-out', ok: true, ip, sessionId: sid });

  // Drop this id from the list and either fall back to whichever session
  // is next, or clear both cookies so the client lands on /login.
  const liveIds = (
    await readLiveSessionIds(getCookie(c, LIST_COOKIE_NAME))
  ).filter((id) => id !== sid);

  if (liveIds.length === 0) {
    clearActiveCookies(c);
    deleteCookie(c, LIST_COOKIE_NAME, COOKIE_OPTS);
    return c.json({ ok: true, nextSessionId: null });
  }

  const next = await db.query.session.findFirst({
    where: eq(schema.session.id, liveIds[0]),
    columns: { id: true, expiresAt: true, email: true },
  });
  if (!next) {
    // Shouldn't happen - readLiveSessionIds filters out dead rows - but
    // play it safe.
    clearActiveCookies(c);
    deleteCookie(c, LIST_COOKIE_NAME, COOKIE_OPTS);
    return c.json({ ok: true, nextSessionId: null });
  }

  setActiveCookies(c, next.id, next.expiresAt);
  writeSessionListCookie(c, liveIds, next.expiresAt);
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

  const liveIds = await readLiveSessionIds(getCookie(c, LIST_COOKIE_NAME));
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

  setActiveCookies(c, row.id, row.expiresAt);
  // Move the just-activated id to the front of the list so it's stable
  // across re-renders.
  const reordered = [row.id, ...liveIds.filter((id) => id !== row.id)];
  writeSessionListCookie(c, reordered, row.expiresAt);
  audit({ event: 'switch', ok: true, ip, email: row.email, sessionId: row.id });
  return c.json({ ok: true, email: row.email });
});

authRoutes.get('/session', async (c) => {
  const sid = getCookie(c, env.SESSION_COOKIE_NAME);
  if (!sid) return c.json(null);
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
  const activeId = getCookie(c, env.SESSION_COOKIE_NAME);
  const liveIds = await readLiveSessionIds(getCookie(c, LIST_COOKIE_NAME));
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
