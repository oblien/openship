/**
 * Auth client for the self-hosted Zero build.
 *
 * Talks to the `/auth/*` endpoints on the Hono server. There is no
 * separate user table - the mailbox is the identity, and the server
 * runs an IMAP LOGIN against the user's mail server to verify the
 * password.
 *
 * Multi-account model:
 *
 *   `zero_session`     (httpOnly)        - active session id
 *   `zero_session_id`  (NOT httpOnly)    - same value, readable from JS
 *                                          so we can namespace the IDB
 *                                          persisted query cache per
 *                                          mailbox.
 *   `zero_sessions`    (httpOnly)        - comma-separated list of every
 *                                          session id the browser is
 *                                          signed in to.
 *
 * Sign-in ADDS to the list and makes the new session active. Sign-out
 * removes the current session and falls back to the next one in the
 * list (or fully signs out if none). Switch just re-points the active
 * cookie at an existing session id.
 *
 * Shape matches what better-auth's `useSession` returned so we don't
 * have to touch every consumer:
 *
 *   useSession() → { data: { user: {...} } | null, isPending, refetch }
 */

import { useEffect, useState, useCallback } from 'react';
import { del as idbDel } from 'idb-keyval';
import { BACKEND_URL } from './backend-url';

const BASE = BACKEND_URL;

// Reads the active connection id from the non-httpOnly companion cookie.
// Lives here too (in addition to root.tsx) so auth-client can scope IDB
// purges to the CURRENT user instead of nuking every account's cache.
function readActiveConnectionId(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)zero_session_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Drop the persisted query cache for ONE connection - used on sign-out so
// the disappearing user's data leaves with them while other accounts on
// the same browser keep their offline state. The key matches the one
// QueryProvider uses to instantiate the IDB persister.
async function purgeConnectionCache(connectionId: string | null): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await idbDel(`zero-query-cache-${connectionId ?? 'default'}`);
  } catch {
    // best-effort - Safari private mode etc.
  }
}

interface ServerSession {
  email: string;
  name: string | null;
  expiresAt: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export interface Session {
  user: SessionUser;
  expiresAt: string;
}

let cache: Session | null | undefined = undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function mapSession(s: ServerSession | null): Session | null {
  if (!s) return null;
  return {
    user: {
      id: s.email,
      email: s.email,
      name: s.name ?? s.email,
      image: null,
    },
    expiresAt: s.expiresAt,
  };
}

async function fetchSession(signal?: AbortSignal): Promise<Session | null> {
  const res = await fetch(`${BASE}/auth/session`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as ServerSession | null;
  return mapSession(body);
}

export async function getSession(): Promise<{ data: Session | null }> {
  const data = await fetchSession();
  cache = data;
  notify();
  return { data };
}

export function useSession(): {
  data: Session | null;
  isPending: boolean;
  refetch: () => Promise<void>;
} {
  const [, setVersion] = useState(0);
  const [isPending, setPending] = useState(cache === undefined);

  const refetch = useCallback(async () => {
    setPending(true);
    cache = await fetchSession();
    setPending(false);
    notify();
  }, []);

  useEffect(() => {
    const tick = () => setVersion((v) => v + 1);
    listeners.add(tick);
    if (cache === undefined) void refetch();
    return () => {
      listeners.delete(tick);
    };
  }, [refetch]);

  return { data: cache ?? null, isPending, refetch };
}

/**
 * Sign-in input - credentials only.
 *
 * The IMAP/SMTP host the server connects to is configured server-side
 * (DEFAULT_IMAP_HOST / DEFAULT_SMTP_HOST). Letting the client choose
 * the host turns sign-in into a credential exfiltration channel - an
 * attacker-controlled login page could redirect the IMAP probe at
 * attacker.example and harvest passwords.
 */
export interface SignInInput {
  email: string;
  password: string;
}

async function signInEmail(input: SignInInput): Promise<{ error: { message: string } | null }> {
  // Cover both credential verification and session confirmation with one
  // deadline. The server's IMAP operation budget is normally 30 seconds; a
  // broken network must not leave the form pending until the browser gives up.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    return await performSignIn(input, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function performSignIn(
  input: SignInInput,
  signal: AbortSignal,
): Promise<{ error: { message: string } | null }> {
  const connectionError = { error: { message: 'Cannot reach webmail. Check your connection and try again.' } };
  const timeoutError = { error: { message: 'Sign in timed out. Please try again.' } };
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth/sign-in`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
  } catch {
    return signal.aborted ? timeoutError : connectionError;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    if (signal.aborted) return timeoutError;
    const fallback = res.status >= 500
      ? 'Webmail is temporarily unavailable. Try again shortly.'
      : 'Sign in failed. Please try again.';
    return { error: { message: typeof body?.error === 'string' && body.error ? body.error : fallback } };
  }
  // Don't purge IDB here. The server now supports multi-account: the
  // existing user(s) keep their session, and the freshly-signed-in user
  // gets their own IDB slot (the persist key is namespaced by session
  // id via the companion cookie). The caller is responsible for the
  // hard navigate that re-mounts root.tsx with the new connection id.
  let signedInSession: Session | null;
  try {
    signedInSession = await fetchSession(signal);
  } catch {
    return signal.aborted ? timeoutError : connectionError;
  }
  if (!signedInSession || signedInSession.user.email.toLowerCase() !== input.email.toLowerCase()) {
    return { error: { message: 'Could not confirm your sign-in. Please try again.' } };
  }
  cache = signedInSession;
  notify();
  return { error: null };
}

function unsupported(name: string): never {
  throw new Error(`${name} is not supported on the self-hosted build.`);
}

export const signIn = {
  email: signInEmail,
  // No OAuth on self-host - kept so legacy callers don't TS-error.
  social: (_: { provider: string }) => unsupported('signIn.social'),
};

export const signUp = {
  email: signInEmail,
};

export async function signOut(opts?: {
  fetchOptions?: { onSuccess?: () => void };
}): Promise<void> {
  // Grab the id BEFORE asking the server - the server clears the cookie
  // (or rotates it to the next session) inside this call.
  const leavingId = readActiveConnectionId();
  await fetch(`${BASE}/auth/sign-out`, { method: 'POST', credentials: 'include' });
  // Drop only THIS user's persisted cache. If the browser is still signed
  // in to another mailbox, its IDB slot stays put - the next hard navigate
  // re-mounts root.tsx with that account's connection id and restores it.
  await purgeConnectionCache(leavingId);
  cache = null;
  notify();
  opts?.fetchOptions?.onSuccess?.();
}

/**
 * Switch the active mailbox to one this browser is already signed in to.
 * The server just re-points the active cookie - no IMAP probe, no
 * re-auth. The caller is responsible for the hard navigate that re-mounts
 * root.tsx with the new connection id.
 */
export async function switchSession(sessionId: string): Promise<{ error: { message: string } | null }> {
  const res = await fetch(`${BASE}/auth/switch`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: 'Switch failed' }))) as {
      error?: string;
    };
    return { error: { message: body.error ?? 'Switch failed' } };
  }
  cache = await fetchSession();
  notify();
  return { error: null };
}

export const $fetch = async (path: string, init?: RequestInit): Promise<Response> => {
  return fetch(`${BASE}${path}`, { credentials: 'include', ...init });
};

// OAuth linking (Google / Outlook etc.) is unsupported on the self-hosted
// build. Kept as a no-op so the connection UI still compiles.
const linkSocial = (_: { provider: string; callbackURL?: string }) =>
  unsupported('authClient.linkSocial');

export const authClient = {
  signIn,
  signUp,
  signOut,
  switchSession,
  useSession,
  getSession,
  $fetch,
  linkSocial,
};
