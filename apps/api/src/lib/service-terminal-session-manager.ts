/**
 * Per-process registry of active SERVICE terminal sessions + tickets.
 *
 * Sibling of `terminal-session-manager.ts` (server-level terminals).
 * Same lifecycle/timer/scrollback design — only the resource identity
 * differs: `serviceId` here, `serverId` over there. The two registries
 * are intentionally separate so a per-user cap on services doesn't
 * silently borrow capacity from server shells (or vice versa).
 *
 * State is RAM-only on purpose:
 *   - Tickets are single-use, short-lived (default 30s).
 *   - Active sessions wrap live PTY streams (Docker exec / Oblien WS)
 *     that die with the process anyway. A boot-time sweep finalizes
 *     orphaned audit rows.
 */

import { randomBytes } from "node:crypto";
import { env } from "../config/env";
import type { ShellSession } from "@repo/adapters";
import type { TerminalExitReason } from "@repo/db";
import type { RequestContext } from "./request-context";

// ─── Tickets ────────────────────────────────────────────────────────────────

interface Ticket {
  token: string;
  userId: string;
  /** Org the user was acting in at mint time — locks the consume-time
   *  scope to the same tenant. See sibling terminal-session-manager.ts. */
  organizationId: string;
  serviceId: string;
  expiresAt: number;
  used: boolean;
}

const tickets = new Map<string, Ticket>();

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function issueServiceTerminalTicket(
  ctx: RequestContext,
  serviceId: string,
): { token: string; expiresIn: number } {
  cleanupExpiredTickets();
  const ttl = env.TERMINAL_TICKET_TTL_MS;
  const token = newToken();
  tickets.set(token, {
    token,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    serviceId,
    expiresAt: Date.now() + ttl,
    used: false,
  });
  return { token, expiresIn: Math.floor(ttl / 1000) };
}

export function consumeServiceTerminalTicket(
  token: string,
): { userId: string; organizationId: string; serviceId: string } | null {
  if (!token) return null;
  const ticket = tickets.get(token);
  if (!ticket) return null;
  tickets.delete(token);
  if (ticket.used) return null;
  if (ticket.expiresAt <= Date.now()) return null;
  return {
    userId: ticket.userId,
    organizationId: ticket.organizationId,
    serviceId: ticket.serviceId,
  };
}

function cleanupExpiredTickets(): void {
  const now = Date.now();
  for (const [token, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(token);
  }
}

// ─── Active sessions ────────────────────────────────────────────────────────

export interface ActiveServiceSession {
  sessionId: string;
  resumeToken: string;
  userId: string;
  serviceId: string;
  startedAt: number;
  shell: ShellSession;
  onTimeout: (sessionId: string, reason: TerminalExitReason) => void;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  hardCapTimer: ReturnType<typeof setTimeout>;
  closed: boolean;
  parked: boolean;
  attachedDataHandler: ((chunk: Buffer) => void) | null;
  scrollback: Buffer[];
  scrollbackSize: number;
}

const sessions = new Map<string, ActiveServiceSession>();
const sessionsByUser = new Map<string, Set<string>>();
const sessionsByResumeToken = new Map<string, ActiveServiceSession>();

export function countActiveServiceSessionsByUser(userId: string): number {
  return sessionsByUser.get(userId)?.size ?? 0;
}

export function maxServiceSessionsPerUser(): number {
  return env.TERMINAL_MAX_SESSIONS_PER_USER;
}

export function registerServiceSession(args: {
  sessionId: string;
  userId: string;
  serviceId: string;
  shell: ShellSession;
  onTimeout: (sessionId: string, reason: TerminalExitReason) => void;
}): ActiveServiceSession {
  const now = Date.now();
  const resumeToken = randomBytes(16).toString("base64url");

  const session: ActiveServiceSession = {
    sessionId: args.sessionId,
    resumeToken,
    userId: args.userId,
    serviceId: args.serviceId,
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

  session.idleTimer = setTimeout(
    () => fireTimeout(session, "idle_timeout"),
    env.TERMINAL_IDLE_TIMEOUT_MS,
  );
  session.hardCapTimer = setTimeout(
    () => fireTimeout(session, "session_cap"),
    env.TERMINAL_HARD_CAP_MS,
  );
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

export function parkServiceSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.closed || session.parked) return false;
  session.parked = true;
  session.attachedDataHandler = null;
  return true;
}

export function getServiceSessionByResumeToken(
  resumeToken: string,
  userId: string,
): ActiveServiceSession | null {
  const session = sessionsByResumeToken.get(resumeToken);
  if (!session) return null;
  if (session.closed) return null;
  if (session.userId !== userId) return null;
  return session;
}

export function attachServiceWs(
  sessionId: string,
  onData: (chunk: Buffer) => void,
): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return false;

  for (const chunk of session.scrollback) {
    try {
      onData(chunk);
    } catch {
      /* WS gone mid-replay */
    }
  }

  session.attachedDataHandler = onData;
  session.parked = false;
  session.lastActivityAt = Date.now();
  return true;
}

export function dispatchServiceStdout(sessionId: string, chunk: Buffer): void {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;

  session.scrollback.push(chunk);
  session.scrollbackSize += chunk.length;
  const cap = env.TERMINAL_SCROLLBACK_BYTES;
  while (session.scrollbackSize > cap && session.scrollback.length > 0) {
    const dropped = session.scrollback.shift()!;
    session.scrollbackSize -= dropped.length;
  }

  const handler = session.attachedDataHandler;
  if (!handler) return;
  try {
    handler(chunk);
  } catch {
    /* peer gone */
  }
}

function fireTimeout(
  session: ActiveServiceSession,
  reason: TerminalExitReason,
): void {
  if (session.closed) return;
  unregisterServiceSession(session.sessionId);
  try {
    session.onTimeout(session.sessionId, reason);
  } catch {
    /* timeout hook is best-effort */
  }
}

export function touchServiceSession(sessionId: string): void {
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

export function unregisterServiceSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.closed) return false;
  session.closed = true;

  clearTimeout(session.idleTimer);
  clearTimeout(session.hardCapTimer);
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

export function getServiceSession(
  sessionId: string,
): ActiveServiceSession | undefined {
  return sessions.get(sessionId);
}
