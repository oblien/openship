/**
 * Interactive terminal controller.
 *
 * Two endpoints:
 *
 *   POST /api/terminal/ticket    → issue a short-lived WS handshake ticket
 *   GET  /api/terminal/ws/:id   → WebSocket upgrade, opens a remote PTY
 *
 * Tickets exist because browsers cannot set Authorization headers on
 * WebSocket() requests. We refuse to authenticate WS via query string
 * (leaks into proxy access logs), and cookie-only auth invites CSRF on
 * the upgrade. So: dashboard hits POST /ticket with its normal Better
 * Auth session → gets a one-shot opaque token → presents it in
 * `Sec-WebSocket-Protocol`. The token is consumed before the channel
 * opens; replay is impossible.
 *
 * Protocol framing:
 *
 *   - Binary frames in BOTH directions are raw PTY bytes. Client→server
 *     bytes are forwarded verbatim to shell.stdin; server→client are
 *     shell.stdout chunks. xterm's onData / write() accept bytes, so
 *     this path is byte-for-byte transparent.
 *
 *   - Text frames are JSON control messages:
 *       client→server: { type: "resize", cols, rows } | { type: "ping" }
 *       server→client: { type: "ready", sessionId } | { type: "exit",
 *           code, signal } | { type: "error", code, message } | { type: "pong" }
 */

import type { Context } from "hono";
import { sshManager } from "../../lib/ssh-manager";
import { auth } from "../../lib/auth";
import { trustedOrigins } from "../../config/env";
import { upgradeWebSocket } from "../../lib/ws";
import { repos } from "@repo/db";
import type { ShellSession } from "@repo/adapters";
import type { TerminalExitReason } from "@repo/db";
import {
  attachWs,
  consumeTerminalTicket,
  countActiveSessionsByUser,
  dispatchStdout,
  getSessionByResumeToken,
  issueTerminalTicket,
  maxSessionsPerUser,
  parkSession,
  registerSession,
  touchSession,
  unregisterSession,
} from "../../lib/terminal-session-manager";
import { getRequestContext } from "../../lib/request-context";
import { resolveActiveOrganizationId } from "../../middleware/active-organization";
import { permission, checkPermission } from "../../lib/permission";
import {
  safeWsSend,
  safeWsClose,
  safeShellWrite,
  safeShellClose,
} from "../../lib/terminal-helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

const SUBPROTOCOL_PREFIX = "openship.terminal.v1+";
const HEARTBEAT_INTERVAL_MS = 25_000;
// Sane bounds applied client-side AND server-side - never trust the wire.
const COLS_MIN = 1, COLS_MAX = 1000;
const ROWS_MIN = 1, ROWS_MAX = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  // Strict equality against the same allowlist used for CORS. We do NOT
  // accept the API origin here because the WS is always opened from the
  // dashboard origin in practice (and accepting any trustedOrigin would
  // include the API itself, broadening the surface).
  return trustedOrigins.includes(origin);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

interface ControlIn {
  type: "resize" | "ping" | "close";
  cols?: number;
  rows?: number;
}
type ControlOut =
  | { type: "ready"; sessionId: string; resumeToken: string; resumed: boolean }
  | { type: "exit"; code: number | null; signal?: string }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "pong" };

/** Wire-level error codes shipped to the client before close. */
type ErrorCode =
  | "ssh_auth"
  | "ssh_connect"
  | "server_not_found"
  | "max_sessions"
  | "idle_timeout"
  | "session_cap"
  | "resume_failed"
  | "server_error";

const RESUME_SUBPROTOCOL_PREFIX = "openship.terminal.resume+";

// ─── Ticket endpoint (POST /api/terminal/ticket) ────────────────────────────

export async function issueTicket(c: Context) {
  const ctx = getRequestContext(c);

  const body = await c.req.json().catch(() => ({}));
  const serverId = typeof body?.serverId === "string" ? body.serverId : "";
  if (!serverId) return c.json({ error: "serverId required" }, 400);

  // Primary gate: opening a PTY is administrative. Even at ticket-mint
  // time we want to reject restricted users without an admin grant — the
  // ticket would otherwise be a "free pass" past the WS upgrade gate below.
  await permission.assert(getRequestContext(c), {
    resourceType: "server",
    resourceId: serverId,
    action: "admin",
  });
  // Existence + cross-org authz check at ticket time. Surface the same
  // 404 the WS would, so the dashboard can show a clear error without
  // burning an upgrade attempt. We use the org-scoped getter — out-of-org
  // (or unknown) server ids return 404 indistinguishably to prevent
  // existence leaks across tenants.
  const server = await repos.server.getInOrganization(serverId, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const { token, expiresIn } = issueTerminalTicket(ctx, serverId);
  return c.json({ success: true, token, expiresIn });
}

// ─── WebSocket upgrade (GET /api/terminal/ws/:serverId) ─────────────────────

/**
 * The factory returns the per-connection event handlers. Auth + origin +
 * server-existence + session-cap checks happen here (before the upgrade
 * is accepted). If we throw or return an error Response, the upgrade is
 * rejected with the appropriate status.
 */
export const terminalWsHandler = upgradeWebSocket(async (c) => {
  // ── 1. Origin allowlist ────────────────────────────────────────────────
  const origin = c.req.header("origin") ?? null;
  if (!isAllowedOrigin(origin)) {
    // upgradeWebSocket cannot return Response from here in a way that
    // sets the right close code, so we let the handler open the socket
    // and immediately send error+close. The Origin header is enforced
    // BEFORE we touch any per-server state, so no leakage.
    return openInitFailure("server_error", "Origin not allowed", 4403);
  }

  // ── 2. Auth via single-use ticket in Sec-WebSocket-Protocol ────────────
  // Browsers send subprotocols as comma-separated values. We expect a
  // ticket value `openship.terminal.v1+<token>` (required) and may also
  // see a `openship.terminal.resume+<resumeToken>` (optional — present
  // when the client is trying to reattach to a parked session).
  const protocols = (c.req.header("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tokenProto = protocols.find((p) => p.startsWith(SUBPROTOCOL_PREFIX));
  const token = tokenProto ? tokenProto.slice(SUBPROTOCOL_PREFIX.length) : "";
  const ticket = token ? consumeTerminalTicket(token) : null;

  const resumeProto = protocols.find((p) => p.startsWith(RESUME_SUBPROTOCOL_PREFIX));
  const resumeToken = resumeProto
    ? resumeProto.slice(RESUME_SUBPROTOCOL_PREFIX.length)
    : "";

  // ── 2b. Fallback: cookie-based session for desktop / same-origin ──────
  // Only used when no ticket was presented. Browsers WILL send cookies
  // on a same-origin WS upgrade, but we still prefer the ticket because
  // it binds (userId, serverId) together.
  let userId: string | null = null;
  let ticketServerId: string | null = null;
  // Resolve activeOrganizationId here — the WS upgrade route deliberately
  // skips the HTTP authMiddleware (auth happens inside this factory), so
  // it's not pre-set on the Hono context. We mirror the middleware's
  // logic: prefer session.activeOrganizationId, fall back to the user's
  // oldest membership.
  // not ctx-scoped: WebSocket upgrade path. This route runs OUTSIDE
  // the normal Hono auth middleware (Bun WS doesn't carry the same
  // request lifecycle), so it has to re-derive the active org from
  // scratch. Both branches funnel through resolveActiveOrganizationId
  // (the canonical resolver from middleware/active-organization.ts) so
  // the WS path applies the same team-org-preferred + memberships[0]
  // fallback as every other authed request — no behavior drift.
  // Foreground non-WS callers must NOT duplicate this pattern — they
  // read ctx.organizationId, which authMiddleware already populated.
  let activeOrgId: string | null = null;
  if (ticket) {
    userId = ticket.userId;
    ticketServerId = ticket.serverId;
    activeOrgId = await resolveActiveOrganizationId(userId, null).catch(() => null);
  } else {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user?.id) {
        userId = session.user.id;
        const sessOrgId =
          (session.session as { activeOrganizationId?: string | null } | null)
            ?.activeOrganizationId ?? null;
        activeOrgId = await resolveActiveOrganizationId(userId, sessOrgId).catch(() => null);
      }
    } catch {
      // fall through to reject below
    }
  }
  if (!userId) return openInitFailure("ssh_auth", "Unauthorized", 4401);
  if (!activeOrgId) return openInitFailure("ssh_auth", "No active organization", 4401);

  // ── 3. Server existence + path-binding sanity ──────────────────────────
  const pathServerId = c.req.param("serverId");
  if (!pathServerId) return openInitFailure("server_not_found", "serverId required", 4400);
  // If we authenticated via ticket, ensure the ticket's serverId matches
  // the path - prevents a ticket for server A being replayed against B.
  if (ticketServerId && ticketServerId !== pathServerId) {
    return openInitFailure("ssh_auth", "Ticket / path mismatch", 4401);
  }
  // Primary gate: opening a PTY is administrative. We call the pure
  // resolver (no Hono context) directly here because the WS upgrade path
  // resolves userId + activeOrgId manually above (authMiddleware is
  // bypassed for the upgrade). 404-shape on deny via openInitFailure so
  // we don't leak existence to non-admins.
  const allowed = await checkPermission(userId, activeOrgId, {
    resourceType: "server",
    resourceId: pathServerId,
    action: "admin",
  });
  if (!allowed) {
    return openInitFailure("server_not_found", "Server not found", 4404);
  }
  // Org-scoped lookup: returns 404 indistinguishably whether the server
  // doesn't exist or belongs to a different org. This is the cross-tenant
  // SSH PTY gate (defense in depth alongside the permission check above).
  const server = await repos.server.getInOrganization(pathServerId, activeOrgId);
  if (!server) return openInitFailure("server_not_found", "Server not found", 4404);

  // ── 4. Per-user concurrent session cap (skipped for resumes) ──────────
  // A resume reuses an existing audit row + ssh channel, so it doesn't
  // count against the cap as a new session. The fresh-shell path runs
  // the cap check; the resume path defers to per-session ownership.
  if (!resumeToken) {
    const inMemoryCount = countActiveSessionsByUser(userId);
    if (inMemoryCount >= maxSessionsPerUser()) {
      return openInitFailure("max_sessions", "Too many active sessions", 4429);
    }
    const dbCount = await repos.terminalSession.countActiveByUser(userId);
    if (dbCount >= maxSessionsPerUser()) {
      return openInitFailure("max_sessions", "Too many active sessions", 4429);
    }
  }

  // ── 5. Capture client metadata for the audit row ───────────────────────
  const clientIp = c.var.clientIp;
  const userAgent = c.req.header("user-agent") ?? null;

  // ── 6. Open the PTY (lazy — happens in onOpen so the failure path
  //       can send a structured error frame before close) ────────────────
  const ctx: HandshakeCtx = {
    userId,
    serverId: pathServerId,
    clientIp,
    userAgent,
    // Echo the subprotocol back so the browser accepts the upgrade.
    subprotocol: tokenProto,
    resumeToken,
  };

  return buildHandlers(ctx);
});

// ─── Per-connection state container ─────────────────────────────────────────

interface HandshakeCtx {
  userId: string;
  serverId: string;
  clientIp: string | null;
  userAgent: string | null;
  subprotocol: string | undefined;
  /** Client-presented resume token (empty if this is a fresh open). */
  resumeToken: string;
}

interface ConnState {
  ctx: HandshakeCtx;
  sessionId: string | null;
  shell: ShellSession | null;
  ws: WSLike | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Guards the cleanup path so it can't run twice. */
  closed: boolean;
  /**
   * True when the client sent a `{type:"close"}` control frame, meaning
   * "I'm permanently closing this shell — do NOT park it". The onClose
   * handler reads this to decide between park and full teardown.
   */
  userTerminated: boolean;
}

// Minimal duck-typed view of the WebSocket the @hono/node-ws handler hands us.
interface WSLike {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

function buildHandlers(ctx: HandshakeCtx) {
  const state: ConnState = {
    ctx,
    sessionId: null,
    shell: null,
    ws: null,
    heartbeatTimer: null,
    closed: false,
    userTerminated: false,
  };

  return {
    /**
     * The handshake has succeeded. Two paths from here:
     *
     *   RESUME: the client presented a valid resume token. Reattach
     *           the WS to the parked session's shell — no new SSH
     *           channel, no new audit row, no cap consumption.
     *
     *   FRESH:  open a new ssh2 PTY shell, write the audit row,
     *           register in the session manager, set up the timers
     *           and the data pump.
     *
     * Both paths converge on (a) wiring shell.onClose, (b) starting
     * the heartbeat, (c) sending `ready`.
     */
    async onOpen(_evt: unknown, ws: WSLike) {
      state.ws = ws;
      // The bytes-to-WS pump used by EITHER path. Defined once so the
      // resume branch can hand the same handler to attachWs().
      const dataPump = (chunk: Buffer) => {
        if (state.closed) return;
        safeWsSend(ws, chunk);
      };

      // ── RESUME path ──────────────────────────────────────────────
      if (ctx.resumeToken) {
        const existing = getSessionByResumeToken(ctx.resumeToken, ctx.userId);
        if (!existing) {
          // Token doesn't match a live session (expired, idle/cap
          // fired, server restarted, or wrong user). Tell the client
          // so it can drop the stale token from localStorage and try
          // a fresh open.
          sendControl(ws, {
            type: "error",
            code: "resume_failed",
            message: "Session is no longer available",
          });
          safeWsClose(ws, 1011, "resume_failed");
          return;
        }

        state.shell = existing.shell;
        state.sessionId = existing.sessionId;
        attachWs(existing.sessionId, dataPump);

        // Wire up shell-exit / heartbeat from the resumed channel.
        // (Note: existing.shell.onClose subscribers from the PREVIOUS
        // WS attachment are stale - they reference a dead `ws`. We
        // can't unsubscribe from ssh2's channel events, but those
        // closures' `state.closed = true` guard makes their writes
        // no-ops. The new onClose subscriber below is the live one.)
        existing.shell.onClose((code: number | null, signal?: string) => {
          sendControl(ws, { type: "exit", code, signal });
          safeWsClose(ws, 1000, "remote_exit");
          void teardown(state, "remote_exit", code);
        });

        state.heartbeatTimer = setInterval(() => {
          sendControl(ws, { type: "pong" });
        }, HEARTBEAT_INTERVAL_MS);
        (state.heartbeatTimer as { unref?: () => void }).unref?.();

        sendControl(ws, {
          type: "ready",
          sessionId: existing.sessionId,
          resumeToken: existing.resumeToken,
          resumed: true,
        });
        return;
      }

      // ── FRESH path ───────────────────────────────────────────────
      let shell: ShellSession;
      let auditId: string | null = null;
      try {
        sshManager.retain(ctx.serverId);
        shell = await sshManager.withExecutor(ctx.serverId, async (exec) => {
          if (!exec.openShell) {
            throw Object.assign(new Error("PTY shell not supported on this executor"), {
              code: "server_error",
            });
          }
          return exec.openShell({ cols: 80, rows: 24, term: "xterm-256color" });
        });
      } catch (err: any) {
        sshManager.release(ctx.serverId);
        const code: ErrorCode = classifySshError(err);
        sendControl(ws, { type: "error", code, message: err?.message || "SSH failure" });
        safeWsClose(ws, 1011, code);
        return;
      }

      state.shell = shell;

      // Audit row open — only after the SSH channel actually succeeded.
      try {
        const row = await repos.terminalSession.open({
          userId: ctx.userId,
          serverId: ctx.serverId,
          clientIp: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        auditId = row.id;
      } catch {
        // Failing to write the audit row should NOT kill an authenticated
        // session - log it and proceed. Boot sweep will not see this
        // session anyway (no row), which is the worst case.
        // eslint-disable-next-line no-console
        console.error("[terminal] failed to write audit open row");
      }

      state.sessionId = auditId;

      const sessionId = auditId ?? `transient-${Date.now()}`;
      const session = registerSession({
        sessionId,
        userId: ctx.userId,
        serverId: ctx.serverId,
        shell,
        onTimeout: (_sid, reason) => {
          sendControl(ws, { type: "error", code: reason as ErrorCode, message: reason });
          safeWsClose(ws, 1011, reason);
          // Timeout truly terminates — not parked.
          void teardown(state, reason, null, /* alreadyUnregistered */ true, /* forceClose */ true);
        },
      });
      state.sessionId = sessionId;

      // Pipe remote stdout/stderr → ws via the session manager's
      // dispatcher. The dispatcher drops bytes while the session is
      // parked (no WS attached) - so the parked-shell output doesn't
      // pile up in memory or pump into a dead WS.
      attachWs(sessionId, dataPump);
      shell.stdout.on("data", (chunk: Buffer) => dispatchStdout(sessionId, chunk));
      shell.stderr.on("data", (chunk: Buffer) => dispatchStdout(sessionId, chunk));

      shell.onClose((code: number | null, signal?: string) => {
        sendControl(ws, { type: "exit", code, signal });
        safeWsClose(ws, 1000, "remote_exit");
        void teardown(state, "remote_exit", code, false, /* forceClose */ true);
      });

      state.heartbeatTimer = setInterval(() => {
        sendControl(ws, { type: "pong" });
      }, HEARTBEAT_INTERVAL_MS);
      (state.heartbeatTimer as { unref?: () => void }).unref?.();

      sendControl(ws, {
        type: "ready",
        sessionId,
        resumeToken: session.resumeToken,
        resumed: false,
      });
    },

    /**
     * Bytes from the client. Binary frames go straight to stdin; text
     * frames are JSON control messages (resize / ping).
     */
    onMessage(evt: { data: unknown }, ws: WSLike) {
      if (state.closed || !state.shell) return;

      const data = evt.data;
      // Binary path - happens for almost every keystroke.
      if (data instanceof ArrayBuffer) {
        writeStdin(state, Buffer.from(data));
        return;
      }
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        writeStdin(state, Buffer.from(data as Uint8Array));
        return;
      }
      // Text path - JSON control. Anything that doesn't parse or doesn't
      // match the schema is silently dropped (no error frame; an attacker
      // shouldn't get feedback for malformed probes).
      if (typeof data === "string") {
        let msg: ControlIn;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg?.type === "resize") {
          const cols = clamp(Number(msg.cols), COLS_MIN, COLS_MAX);
          const rows = clamp(Number(msg.rows), ROWS_MIN, ROWS_MAX);
          state.shell.setWindow(cols, rows);
          return;
        }
        if (msg?.type === "ping") {
          if (state.sessionId) touchSession(state.sessionId);
          sendControl(ws, { type: "pong" });
          return;
        }
        if (msg?.type === "close") {
          // Explicit user-initiated termination. Mark the flag and
          // let the WS close naturally — the onClose handler reads
          // userTerminated to choose forceClose over park. We also
          // close immediately so the teardown is prompt.
          state.userTerminated = true;
          safeWsClose(ws, 1000, "client_terminate");
          return;
        }
      }
    },

    /**
     * Client (or peer / proxy) closed the socket. Default behavior is
     * to PARK the session (keep PTY + audit row alive for resume); the
     * client signals explicit termination by sending `{type:"close"}`
     * which sets state.userTerminated, and we honor that with a full
     * teardown instead.
     */
    onClose() {
      void teardown(
        state,
        state.userTerminated ? "client_close" : "client_close",
        null,
        false,
        /* forceClose */ state.userTerminated,
      );
    },

    /**
     * Transport error - same handling as client close (park, don't
     * destroy). Distinguishable in the audit only by which side of the
     * WS fired - but since neither involves the shell exiting, both
     * should let the user reattach.
     */
    onError() {
      void teardown(state, "client_close", null, false, /* forceClose */ false);
    },
  };
}

/** Write client bytes to the shell's stdin. */
function writeStdin(state: ConnState, buf: Buffer): void {
  if (!state.shell) return;
  if (state.sessionId) touchSession(state.sessionId);
  safeShellWrite(state.shell, buf);
}

// ─── Teardown ───────────────────────────────────────────────────────────────

/**
 * Single teardown path used by every termination trigger.
 *
 *   forceClose=true   → really tear down (remote shell exit, idle/cap
 *                       timeout, server error). The PTY is killed, the
 *                       SSH retain released, the audit row finalized.
 *
 *   forceClose=false  → PARK the session: detach the WS but keep the
 *                       PTY + audit row alive so the client can resume
 *                       on the next reconnect. Heartbeat is stopped
 *                       (no WS to send pongs to); shell + sshManager
 *                       retain are preserved. The session manager's
 *                       idle + hard-cap timers continue running.
 *
 * Idempotent in both modes via the `state.closed` flag.
 */
async function teardown(
  state: ConnState,
  reason: TerminalExitReason,
  exitCode: number | null,
  alreadyUnregistered = false,
  forceClose = true,
) {
  if (state.closed) return;
  state.closed = true;

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  // PARK path - keep the shell + audit row alive for resume.
  if (!forceClose && state.sessionId) {
    parkSession(state.sessionId);
    return;
  }

  if (state.shell) {
    safeShellClose(state.shell);
    state.shell = null;
  }

  // unregisterSession is the SINGLE definitive session-end. It owns releasing
  // the SSH retain (acquired at openShell) — reached from every path including
  // the idle/cap timeout, which unregisters BEFORE this teardown runs. Doing the
  // release there (not here) keeps it atomic with session lifetime: the park path
  // never reaches this, so a parked-then-resumed session keeps its connection
  // pinned, and a parked-then-timed-out session still releases exactly once.
  if (!alreadyUnregistered && state.sessionId) {
    unregisterSession(state.sessionId);
  }

  // Finalize the audit row if we wrote one.
  if (state.sessionId && !state.sessionId.startsWith("transient-")) {
    try {
      await repos.terminalSession.close(state.sessionId, {
        exitCode,
        exitReason: reason,
      });
    } catch {
      // No way to recover; the boot-time sweep will eventually close it
      // with reason='server_error' on a future restart.
    }
  }
}

// ─── Wire helpers ───────────────────────────────────────────────────────────

function sendControl(ws: WSLike, msg: ControlOut): void {
  safeWsSend(ws, JSON.stringify(msg));
}

/**
 * Build a no-op handler bundle that opens the WS only to immediately
 * send an error frame and close. Used when a handshake-time check fails
 * but we've already committed to the upgrade in upgradeWebSocket. The
 * application close code is in the 4xxx range (per RFC 6455 §7.4.2).
 */
function openInitFailure(code: ErrorCode, message: string, closeCode: number) {
  return {
    onOpen(_evt: unknown, ws: WSLike) {
      sendControl(ws, { type: "error", code, message });
      safeWsClose(ws, closeCode, code);
    },
    onMessage() { /* drop */ },
    onClose() { /* nothing to clean */ },
    onError() { /* nothing to clean */ },
  };
}

function classifySshError(err: any): ErrorCode {
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("authentication") || msg.includes("auth") || msg.includes("permission denied")) {
    return "ssh_auth";
  }
  if (
    msg.includes("connect") ||
    msg.includes("timed out") ||
    msg.includes("unreachable") ||
    msg.includes("handshake") ||
    msg.includes("refused")
  ) {
    return "ssh_connect";
  }
  return "server_error";
}
