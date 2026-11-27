import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie, setCookie, deleteCookie } from 'hono/cookie';
import { inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { sessionCookieKey } from './crypto';

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

// The client uses the public row ID to select its local mailbox cache.
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
function evictShadowCookies(c: Context) {
  // Which host's wide scopes to clear. COOKIE_DOMAIN is legacy config that
  // openship no longer sets (the catalog app is one image on any hostname), so
  // fall back to the host the browser is already talking to — which is exactly
  // the host whose shadow cookie would shadow ours. Attacker-controlled Host
  // only ever produces extra `Max-Age=0` deletes for a domain the browser isn't
  // in scope for, i.e. no-ops: nothing here can SET a cookie.
  const requestHost = (c.req.header('host') ?? '').split(':')[0].toLowerCase();
  const configured = env.COOKIE_DOMAIN !== 'localhost' ? env.COOKIE_DOMAIN : requestHost;
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

// Keep the active credential and the account-switching grant distinct. Older
// unsigned cookies must be renewed by signing in with the mailbox password.
const activeKey = sessionCookieKey(env.SESSION_COOKIE_NAME);
const listKey = sessionCookieKey(LIST_COOKIE_NAME);

export async function readActiveSessionId(c: Context): Promise<string | undefined> {
  return (await getSignedCookie(c, activeKey, env.SESSION_COOKIE_NAME)) || undefined;
}

export async function activateSession(c: Context, id: string, expiresAt: Date, liveIds: string[]) {
  evictShadowCookies(c);
  const options = { ...COOKIE_OPTS, expires: expiresAt };
  await setSignedCookie(c, env.SESSION_COOKIE_NAME, id, activeKey, options);
  const ordered = [id, ...liveIds.filter(other => other !== id)];
  await setSignedCookie(c, LIST_COOKIE_NAME, ordered.join(','), listKey, options);
  setCookie(c, ACTIVE_ID_COOKIE_NAME, id, { ...PUBLIC_COOKIE_OPTS, expires: expiresAt });
}

export function clearActiveCookies(c: Context) {
  evictShadowCookies(c);
  deleteCookie(c, env.SESSION_COOKIE_NAME, COOKIE_OPTS);
  deleteCookie(c, ACTIVE_ID_COOKIE_NAME, PUBLIC_COOKIE_OPTS);
}

// Parse the multi-session cookie, dedupe, and drop ids whose rows no
// longer exist (expired/deleted). Returns the surviving list, freshest
// first.
export async function readLiveSessionIds(c: Context): Promise<string[]> {
  const raw = await getSignedCookie(c, listKey, LIST_COOKIE_NAME);
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

export function clearSessionCookies(c: Context) {
  clearActiveCookies(c);
  deleteCookie(c, LIST_COOKIE_NAME, COOKIE_OPTS);
}
