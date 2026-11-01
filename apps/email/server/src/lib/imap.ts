/**
 * IMAP client helpers - wraps `imapflow`.
 *
 * Each request opens a short-lived IMAP connection. On the same VPS
 * the TCP+TLS handshake against Dovecot is sub-millisecond - pooling
 * adds complexity for no win at the scale of self-hosted webmail
 * (typically one operator's mailboxes, not thousands).
 *
 * The IDLE listener in `routes/idle.ts` is the one place that holds a
 * connection open; it lives outside this helper.
 */

import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { classifyImapFailure } from './imap-errors';

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** All webmail connections use the same TLS policy, including mailbox IDLE. */
export function createImapClient(
  auth: ImapAuth,
  options: Pick<ImapFlowOptions, 'socketTimeout' | 'disableAutoIdle' | 'maxIdleTime'> = {},
): ImapFlow {
  const client = new ImapFlow({
    ...options,
    host: auth.host,
    port: auth.port,
    secure: auth.port === 993,
    doSTARTTLS: auth.port === 993 ? undefined : true,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  // ImapFlow can emit a pending AUTH error after close() has already rejected
  // connect(). Callers attach their active error handler before connecting; this
  // harmless final listener prevents a late event from crashing the process
  // after that handler is removed. The closed, per-request client is GC-owned.
  client.on('error', () => {});
  return client;
}

/**
 * Budget for connecting and running `withImap`'s `fn`. imapflow has socket
 * and greeting timeouts, but no per-command guard - a slow `SEARCH HEADER`
 * over a large mailbox can sit idle for minutes without surfacing an error.
 * 30 s covers the slowest legitimate full-mailbox scan on Dovecot without
 * FTS; anything slower is a bug worth surfacing as a clear TRPC error
 * rather than a stalled request.
 */
const DEFAULT_OPERATION_TIMEOUT_MS = (() => {
  const raw = process.env.IMAP_OPERATION_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

export class ImapTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`IMAP operation timed out after ${timeoutMs} ms`);
    this.name = 'ImapTimeoutError';
  }
}

/**
 * Open a fresh IMAP connection, run `fn`, then close it. The connection
 * is always closed even if `fn` throws.
 *
 * Use this for one-shot operations (list / get / flag). For long-lived
 * IDLE, manage the ImapFlow lifecycle directly.
 *
 * TIMEOUT HANDLING:
 * - The race fires when `fn` exceeds `timeoutMs`, but Promise.race CANNOT
 *   cancel the in-flight IMAP command. The imapflow client still has a
 *   live socket with a pending request queued behind it.
 * - We MUST NOT `await client.logout()` on the timeout path. LOGOUT
 *   enqueues behind the still-pending request and won't be sent until
 *   that request completes - which is exactly the thing that took too
 *   long. The whole `withImap` call would block on cleanup, defeating
 *   the timeout.
 * - On timeout (or any error), we drop the socket synchronously via
 *   `client.close()` to release file descriptors and unblock the caller.
 * - On the happy path we wrap `logout()` in its own short race so a
 *   misbehaving server can't block successful responses either.
 *
 * INSTRUMENTATION:
 * Set IMAP_DEBUG=1 to log per-step timings (connect, fn, teardown).
 */
const TEARDOWN_TIMEOUT_MS = 2_000;
const IMAP_DEBUG = process.env.IMAP_DEBUG === '1';

function imapDebug(message: string, extra?: Record<string, unknown>) {
  if (!IMAP_DEBUG) return;
  const ts = new Date().toISOString();
  const parts = [`[imap] ${ts} ${message}`];
  if (extra) parts.push(JSON.stringify(extra));
  console.log(parts.join(' '));
}

export async function withImap<T>(
  auth: ImapAuth,
  fn: (client: ImapFlow) => Promise<T>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const label = options.label ?? 'imap';
  const startedAt = performance.now();
  const client = createImapClient(auth, {
    // socketTimeout is imapflow's idle-socket guard. Setting it to the
    // operation budget gives the wire layer the same ceiling as the
    // logical operation - a stuck socket bails out at the same point
    // the timeout race below would, instead of much later.
    socketTimeout: timeoutMs,
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  let didError = false;
  let connected = false;
  let onError!: (error: Error) => void;
  const connectionError = new Promise<never>((_, reject) => { onError = reject; });
  // Socket errors can arrive as events instead of connect()/command rejections.
  client.on('error', onError);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      reject(new ImapTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const fnStart = performance.now();
  try {
    await Promise.race([client.connect(), timeoutPromise, connectionError]);
    connected = true;
    imapDebug(`${label}: connected`, { host: auth.host, user: auth.user, ms: Math.round(performance.now() - startedAt) });
    const result = await Promise.race([fn(client), timeoutPromise, connectionError]);
    imapDebug(`${label}: fn ok`, { ms: Math.round(performance.now() - fnStart) });
    return result;
  } catch (err: any) {
    didError = true;
    imapDebug(`${label}: fn failed`, {
      ms: Math.round(performance.now() - fnStart),
      timeout: didTimeout,
      // AUTH errors can carry raw commands. Log only their category before
      // connection succeeds, even when diagnostic timing is enabled.
      ...(connected ? { message: err?.message } : { failure: classifyImapFailure(err) }),
    });
    // imapflow throws `new Error('Command failed')` for any NO/BAD response,
    // attaching the actual server text on `responseText` and the wire-format
    // command on `executedCommand`. Surface both so tRPC errors are
    // actionable instead of a bare "Command failed".
    if (connected && err && typeof err === 'object' && err.message === 'Command failed') {
      const detail = [err.responseText, err.executedCommand].filter(Boolean).join(' :: ');
      if (detail) err.message = `IMAP command failed: ${detail}`;
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Teardown strategy - see the long comment at the top of this function.
    // On timeout or error we MUST drop the socket synchronously; awaiting
    // logout() queues behind the still-pending command and re-blocks the
    // caller for the entire timeout window again.
    if (didTimeout || didError) {
      try {
        client.close();
      } catch {
        /* socket already dead, ignore */
      }
      imapDebug(`${label}: torn down forcibly`, { total: Math.round(performance.now() - startedAt) });
    } else {
      // Happy path - graceful LOGOUT, but with its own short race so a
      // misbehaving server can't block successful responses either.
      // Capture the timer handle so the win-by-logout case can cancel
      // it; otherwise the 2s timer stays armed (libuv ref'd) and keeps
      // short-lived workers (probeImap, tests, CLIs) from exiting cleanly
      // even though the IMAP op completed milliseconds ago.
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.logout(),
          connectionError,
          new Promise<void>((resolve) => {
            teardownTimer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS);
          }),
        ]);
      } catch {
        /* close-on-shutdown best effort */
      } finally {
        if (teardownTimer) clearTimeout(teardownTimer);
      }
      try {
        client.close();
      } catch {
        /* already closed by logout */
      }
      imapDebug(`${label}: torn down cleanly`, { total: Math.round(performance.now() - startedAt) });
    }
    client.removeListener('error', onError);
  }
}

/**
 * Quick credential check: opens an IMAP connection and immediately
 * closes it. False means the server rejected the credentials. Connection,
 * TLS and server failures throw so `/auth/sign-in` can report unavailability.
 */
export async function probeImap(auth: ImapAuth): Promise<boolean> {
  try {
    await withImap(auth, async () => {
      // connection succeeded; nothing else to do.
    });
    return true;
  } catch (error) {
    if (classifyImapFailure(error) === 'credentials') return false;
    throw error;
  }
}
