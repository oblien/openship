/**
 * Per-process registry of active interactive terminal sessions and the
 * one-shot tickets used to authenticate WebSocket handshakes.
 *
 * State is RAM-only on purpose:
 *
 *   - Tickets are short-lived (default 30s) and single-use — outliving
 *     the process is meaningless.
 *   - Active sessions wrap live ssh2 channels that die with the process
 *     anyway; rebuilding the registry from disk would point at dead
 *     channels. A boot-time `closeAllActive()` on the audit repo
 *     finalizes any rows orphaned by a previous crash.
 *
 * Two enforcement primitives live here:
 *
 *   - per-user concurrent session cap (TERMINAL_MAX_SESSIONS_PER_USER)
 *   - per-session idle (TERMINAL_IDLE_TIMEOUT_MS) and hard-cap
 *     (TERMINAL_HARD_CAP_MS) timers
 *
 * Timers fire `onTimeout(sessionId, reason)` so the controller can
 * close the WS / kill the shell / finalize the audit row from one
 * place. Nothing else owns lifecycle.
 */

import { randomBytes } from "node:crypto";
import { env } from "@repo/platform/engine/config/env";
import type { ShellSession } from "@repo/adapters";
import type { TerminalExitReason } from "@repo/db";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";

// ─── Tickets ────────────────────────────────────────────────────────────────

interface Ticket {
  token: string;
  userId: string;
  /** Org the user was acting in at mint time. The WS upgrade scopes
   *  every downstream check (permission, server existence, audit) to
   *  this org — NOT to whatever org the user happens to be in at
   *  consume time. Mint and consume share the same tenant. */
  organizationId: string;
  serverId: string;
  /** Wall-clock expiry (Date.now()). */
  expiresAt: number;
  /** Once true, the ticket has been consumed and can never be redeemed again. */
  used: boolean;
}

const tickets = new Map<string, Ticket>();

function newToken(): string {
  // 32 bytes → 64 base64url chars, plenty of entropy for one-shot use.
  return randomBytes(32).toString("base64url");
}

/**
 * Mint a single-use ticket binding (userId, organizationId, serverId).
 * The org comes from `ctx.organizationId` — that's the org the user
 * explicitly chose / had scoped for them when they hit the mint
 * endpoint. The WS upgrade later operates against THAT org, not
 * whatever the user's session-active-org happens to be at consume
 * time. Returns the token the client echoes back via
 * `Sec-WebSocket-Protocol` on the WS upgrade. Default TTL:
 * env.TERMINAL_TICKET_TTL_MS.
 */
export function issueTerminalTicket(
  ctx: RequestContext,
  serverId: string,
): { token: string; expiresIn: number } {
  cleanupExpiredTickets();
  const ttl = env.TERMINAL_TICKET_TTL_MS;
  const token = newToken();
  tickets.set(token, {
    token,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    serverId,
    expiresAt: Date.now() + ttl,
    used: false,
  });
  return { token, expiresIn: Math.floor(ttl / 1000) };
}

/**
 * Consume a ticket. Returns the bound (userId, organizationId, serverId)
 * on success and deletes the ticket. Returns null on missing / expired
 * / already-used, never revealing which failure case occurred
 * (timing-uniform).
 */
export function consumeTerminalTicket(token: string): {
  userId: string;
  organizationId: string;
  serverId: string;
} | null {
  if (!token) return null;
  const ticket = tickets.get(token);
  if (!ticket) return null;
  // Delete first so a parallel handshake racing on the same token can
  // only ever resolve once.
  tickets.delete(token);
  if (ticket.used) return null;
  if (ticket.expiresAt <= Date.now()) return null;
  return {
    userId: ticket.userId,
    organizationId: ticket.organizationId,
    serverId: ticket.serverId,
  };
}

function cleanupExpiredTickets(): void {
  const now = Date.now();
  for (const [token, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(token);
  }
}

// ─── Active sessions ────────────────────────────────────────────────────────

export interface ActiveSession {
  /** Audit-row id (terminal_sessions.id). */
  sessionId: string;
  /**
   * Per-session random secret presented by the client at WS open to
   * resume a parked session. Distinct from sessionId (which is the
   * audit-row id) so leaking the audit id alone cannot hijack a shell.
   */
  resumeToken: string;
  userId: string;
  serverId: string;
  startedAt: number;
  shell: ShellSession;
  /** Caller-provided cleanup hook fired on timeout / explicit termination. */
  onTimeout: (sessionId: string, reason: TerminalExitReason) => void;
  /** Reset on every client→server byte to defer the idle timer. */
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  hardCapTimer: ReturnType<typeof setTimeout>;
  /** Guards against double-close from concurrent paths (timeout vs WS close vs shell exit). */
  closed: boolean;
  /**
   * True when there is no attached WS (the client disconnected but the
   * shell + audit row are kept alive for resume). The PTY keeps running
   * and stdout bytes accumulate in `scrollback` until a new WS attaches.
   * Idle / hard-cap timers continue regardless of parked state.
   */
  parked: boolean;
  /**
   * Bytes-to-stdout pipe currently attached to the WS. Replaced by
   * attachWs() and cleared by parkSession() so the previous WS doesn't
   * keep receiving bytes after detach.
   */
  attachedDataHandler: ((chunk: Buffer) => void) | null;
  /**
   * Bounded ring buffer of recent PTY stdout. Used to replay the
   * pre-disconnect screen state to a resuming client so they see
   * "where they left off" instead of an empty xterm. Trimmed from
   * the head when total bytes exceed env.TERMINAL_SCROLLBACK_BYTES.
   */
  scrollback: Buffer[];
  scrollbackSize: number;
}

const sessions = new Map<string, ActiveSession>();
const sessionsByUser = new Map<string, Set<string>>();
const sessionsByResumeToken = new Map<string, ActiveSession>();

/**
 * Snapshot of the per-user count from in-memory state. We separately
 * check the audit repo for `countActiveByUser` at handshake (defense in
 * depth: if a session-manager bug leaks an in-memory entry, the DB count
 * will be the conservative number that gates new sessions).
 */
export function countActiveSessionsByUser(userId: string): number {
  return sessionsByUser.get(userId)?.size ?? 0;
}

export function maxSessionsPerUser(): number {
  return env.TERMINAL_MAX_SESSIONS_PER_USER;
}

/**
 * Register a fully-opened session. Wires up idle + hard-cap timers; the
 * timers call onTimeout with the right reason and immediately remove the
 * entry from the registry (so the controller's cleanup path is the same
 * regardless of trigger).
 *
 * Generates a fresh `resumeToken` — the controller returns this to the
 * client in the `ready` frame, and the client presents it at later WS
 * upgrades to reattach to a parked session.
 */
export function registerSession(args: {
  sessionId: string;
  userId: string;
  serverId: string;
  shell: ShellSession;
  onTimeout: (sessionId: string, reason: TerminalExitReason) => void;
}): ActiveSession {
  const now = Date.now();
  const resumeToken = randomBytes(16).toString("base64url");

  const session: ActiveSession = {
    sessionId: args.sessionId,
    resumeToken,
    userId: args.userId,
    serverId: args.serverId,
    startedAt: now,
    shell: args.shell,
    onTimeout: args.onTimeout,
    lastActivityAt: now,
    closed: false,
    parked: false,
    attachedDataHandler: null,
    scrollback: [],
    scrollbackSize: 0,
    idleTimer: undefined as unknown as ReturnType<typeof setTimeout>,
    hardCapTimer: undefined as unknown as ReturnType<typeof setTimeout>,
  };

  session.idleTimer = setTimeout(() => fireTimeout(session, "idle_timeout"), env.TERMINAL_IDLE_TIMEOUT_MS);
  session.hardCapTimer = setTimeout(() => fireTimeout(session, "session_cap"), env.TERMINAL_HARD_CAP_MS);
  // Don't keep the event loop alive solely for these timers.
  (session.idleTimer as { unref?: () => void }).unref?.();
  (session.hardCapTimer as { unref?: () => void }).unref?.();

  sessions.set(session.sessionId, session);
  sessionsByResumeToken.set(resumeToken, session);
  let userSet = sessionsByUser.get(session.userId);
  if (!userSet) {
    userSet = new Set();
    sessionsByUser.set(session.userId, userSet);
  }
  userSet.add(session.sessionId);

  return session;
}

/**
 * Park a session - the WS detached but the shell + audit row stay
 * alive. Subsequent shell stdout is dropped until a new WS attaches.
 * Idle + hard-cap timers continue running. Returns true if the
 * session was actually parked (false if already closed or already
 * parked - both treated as no-ops).
 */
export function parkSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.closed || session.parked) return false;
  session.parked = true;
  // Detach the stdout pipe so the WS that's about to close doesn't
  // receive any more bytes from the live shell.
  session.attachedDataHandler = null;
  return true;
}

/**
 * Look up a parked (or active — defensive) session by its resume token,
 * scoped to a userId. Returns null on miss / wrong owner / already closed.
 */
export function getSessionByResumeToken(
  resumeToken: string,
  userId: string,
): ActiveSession | null {
  const session = sessionsByResumeToken.get(resumeToken);
  if (!session) return null;
  if (session.closed) return null;
  if (session.userId !== userId) return null;
  return session;
}

/**
 * Attach a stdout pipe to a session. Replays the session's scrollback
 * buffer to the new handler BEFORE swapping it in as the live pipe —
 * so a resuming client sees the screen as it was at disconnect, then
 * any new output flows naturally on top. JS is single-threaded so the
 * replay runs atomically before the next ssh2 'data' callback can
 * fire; no interleaving risk.
 *
 * Touches `lastActivityAt` so a resume defers the idle timer.
 */
export function attachWs(
  sessionId: string,
  onData: (chunk: Buffer) => void,
): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return false;

  // Replay first. Don't trap an error in the loop — if onData throws
  // on chunk N, the underlying WS is likely already gone and we want
  // to bail before swapping the handler in.
  for (const chunk of session.scrollback) {
    try { onData(chunk); } catch { /* WS gone mid-replay */ }
  }

  session.attachedDataHandler = onData;
  session.parked = false;
  session.lastActivityAt = Date.now();
  return true;
}

/**
 * The internal stdout dispatcher. The controller wires the shell's
 * 'data' event to call this. We do two things on every chunk:
 *   1. Append to the bounded scrollback ring (for resume replay).
 *   2. Forward to the currently-attached WS handler (if any).
 * When parked, step 1 still runs (so the resumer sees what they
 * missed); step 2 drops the chunk on the floor.
 */
export function dispatchStdout(sessionId: string, chunk: Buffer): void {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;

  // Append + trim. We keep dropping head chunks until the total
  // is back under the cap. Whole-chunk drops mean we may lose
  // slightly more than necessary, but the alternative (slicing the
  // head chunk) is more work for negligible benefit.
  session.scrollback.push(chunk);
  session.scrollbackSize += chunk.length;
  const cap = env.TERMINAL_SCROLLBACK_BYTES;
  while (session.scrollbackSize > cap && session.scrollback.length > 0) {
    const dropped = session.scrollback.shift()!;
    session.scrollbackSize -= dropped.length;
  }

  const handler = session.attachedDataHandler;
  if (!handler) return; // parked
  try { handler(chunk); } catch { /* peer gone */ }
}

function fireTimeout(session: ActiveSession, reason: TerminalExitReason): void {
  if (session.closed) return;
  // Drop from registry first so the controller's cleanup can't double-fire.
  unregisterSession(session.sessionId);
  try { session.onTimeout(session.sessionId, reason); } catch { /* timeout hook is best-effort */ }
}

/**
 * Bump activity. Re-arms the idle timer. Does NOT extend the hard cap
 * (by design — that's the absolute ceiling).
 */
export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;
  session.lastActivityAt = Date.now();
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(
    () => fireTimeout(session, "idle_timeout"),
    env.TERMINAL_IDLE_TIMEOUT_MS,
  );
  (session.idleTimer as { unref?: () => void }).unref?.();
}

/**
 * Remove a session from the registry and clear its timers. Idempotent —
 * safe to call from the WS close, the shell exit, the timeout path, all
 * three. Returns true if this call did the unregister (caller can use
 * this to gate audit close + extra teardown).
 */
export function unregisterSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.closed) return false;
  session.closed = true;

  // Release the SSH connection hold acquired when this terminal opened. This is
  // the single, atomic release point — park/resume never unregister — so the
  // shared connection stays pinned for the EXACT session lifetime (surviving
  // background command churn via dropServer's retain guard) and is freed
  // exactly once: no leak on the park→timeout path, no early drop on resume.
  sshManager.release(session.serverId);

  clearTimeout(session.idleTimer);
  clearTimeout(session.hardCapTimer);
  // Free the scrollback memory promptly — these Buffers can be up to
  // env.TERMINAL_SCROLLBACK_BYTES total per session.
  session.scrollback = [];
  session.scrollbackSize = 0;
  sessions.delete(sessionId);
  sessionsByResumeToken.delete(session.resumeToken);
  const userSet = sessionsByUser.get(session.userId);
  if (userSet) {
    userSet.delete(sessionId);
    if (userSet.size === 0) sessionsByUser.delete(session.userId);
  }
  return true;
}

export function getSession(sessionId: string): ActiveSession | undefined {
  return sessions.get(sessionId);
}
