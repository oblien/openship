/**
 * Interactive SERVICE terminal controller.
 *
 * Sibling of modules/terminal/terminal.controller.ts (which exposes
 * server-level SSH shells). The wire protocol — subprotocol-token
 * auth, binary PTY frames, JSON resize/ping/exit/close — is identical,
 * so the dashboard's xterm + usePtyConnection layers are nearly
 * symmetric across both endpoints.
 *
 * The only thing that differs is the resolution step:
 *   - server terminal:  sshManager.openShell() against `servers.id`
 *   - service terminal: runtime.openServiceShell() against the
 *                        deployed container/workspace id, where the
 *                        runtime is selected per-service from the
 *                        owning deployment's meta (Docker vs Cloud).
 *
 * Two endpoints:
 *   POST /api/services/:serviceId/terminal/ticket → mint a WS ticket
 *   GET  /api/services/:serviceId/terminal/ws     → WS upgrade
 *
 * Subprotocol prefix: "openship.terminal.v1+" (shared with server
 * terminal — the prefix isn't resource-scoped). Resume subprotocol
 * prefix: "openship.terminal.resume+" (same).
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { trackBackgroundWork } from "@repo/platform/engine/lib/background-work";
import type { Context } from "hono";
import {
  TERMINAL_SUBPROTOCOL_PREFIX as SUBPROTOCOL_PREFIX,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX as RESUME_SUBPROTOCOL_PREFIX,
  TERMINAL_COLS_MAX as COLS_MAX, TERMINAL_ROWS_MAX as ROWS_MAX,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { trustedOrigins } from "@repo/platform/engine/config/env";
import { upgradeWebSocket } from "../../lib/ws";
import { prepareCloudTerminal, cloudTerminalHandlers } from "../../lib/cloud/terminal-bridge";
import { repos } from "@repo/db";
import type { ShellSession } from "@repo/adapters";
import type { TerminalExitReason } from "@repo/db";
import { disposeRuntime, resolveDeploymentRuntime } from "@repo/platform/engine/lib/deployment-runtime";
import { holdCloudWorkspaceActivity } from "@repo/platform/engine/lib/cloud-workspace-lock";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { resolveTerminalContext, watchTerminalAuthorization } from "../../lib/terminal-authorization";
import { authorization } from "@repo/platform/engine/lib/authorization";
import type { ExecutionContext } from "@repo/platform";
import { containerIdForService, liveContainerIdWithRuntime } from "@repo/platform/engine/modules/services/service-container";
import {
  attachServiceWs,
  consumeServiceTerminalTicket,
  countActiveServiceSessionsByUser,
  dispatchServiceStdout,
  getServiceSessionByResumeToken,
  issueServiceTerminalTicket,
  maxServiceSessionsPerUser,
  parkServiceSession,
  registerServiceSession,
  touchServiceSession,
  unregisterServiceSession,
} from "../../lib/service-terminal-session-manager";
import {
  safeWsSend,
  safeWsClose,
  safeShellWrite,
  safeShellClose,
} from "../../lib/terminal-helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000;
const COLS_MIN = 1;
const ROWS_MIN = 1;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
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

type ErrorCode =
  | "ssh_auth" // reused for "auth failed at upgrade"
  | "ssh_connect" // reused for "runtime open failed"
  | "server_not_found" // reused for "service not found"
  | "max_sessions"
  | "idle_timeout"
  | "session_cap"
  | "resume_failed"
  | "server_error"
  | "not_supported" // runtime lacks serviceShell capability
  | "not_deployed"; // service has no running container yet

// ─── Service ownership + resolution ─────────────────────────────────────────

/**
 * Look up the service, verify the parent project belongs to the caller's
 * active organization, and resolve the runtime + containerId. Returns
 * null on any failure with a structured reason — controller decides
 * which close code to emit.
 *
 * Scoping is by `project.organizationId` rather than `project.userId`
 * so authorized org members can use terminals for shared projects.
 */
async function resolveServiceForOrg(
  serviceId: string,
  ctx: ExecutionContext,
  forShell = false,
): Promise<
  | { ok: true; projectId: string; containerId: string; runtime: import("@repo/adapters").RuntimeAdapter;
      openShell?: () => Promise<ShellSession>; release?: () => Promise<void> }
  | { ok: false; code: ErrorCode; message: string }
> {
  const service = await repos.service.findById(serviceId);
  if (!service) return { ok: false, code: "server_not_found", message: "Service not found" };

  // Apply the same credential and tenant policy as HTTP operations. Never
  // substitute the token owner's broader membership for its explicit grants.
  const allowed = await authorization.checkPermissionOnResource(ctx, {
    resourceType: "project",
    resourceId: service.projectId,
    action: "admin",
  });
  if (!allowed) {
    return { ok: false, code: "server_not_found", message: "Service not found" };
  }

  const project = await repos.project.findById(service.projectId);
  if (
    !project ||
    (project.organizationId != null && project.organizationId !== ctx.organizationId)
  ) {
    // Same 404-shape as backup endpoints: don't leak existence vs.
    // authorization; the shared policy above also validates ownership.
    return { ok: false, code: "server_not_found", message: "Service not found" };
  }

  if (!project.activeDeploymentId) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Project has no active deployment yet",
    };
  }
  const dep = await findActiveDeployment(project);
  if (!dep) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Active deployment not found",
    };
  }

  // Resolve the runtime that built/owns this deployment (Docker vs Cloud).
  // The current caller's userId is forwarded for any cloud-side audit;
  // the deployment's org context determines cloud tenancy.
  let runtime: import("@repo/adapters").RuntimeAdapter;
  let activity: Awaited<ReturnType<typeof holdCloudWorkspaceActivity>> | undefined;
  try {
    if (forShell && project.workspaceId)
      activity = await holdCloudWorkspaceActivity(project.workspaceId, "service-terminal:" + serviceId);
    const resolve = () => resolveDeploymentRuntime({
      // A service is a CONTAINER, never the app's bare host process — pin the
      // docker runtime so the terminal targets the real service runtime (as
      // every other service action does via resolveServicePlatform), even when
      // the project's app itself deploys "bare".
      meta: { ...(dep.meta as Record<string, unknown> | null), runtimeMode: "docker" },
      organizationId: dep.organizationId,
      projectId: dep.projectId,
    });
    const resolved = await (activity ? activity.run(resolve) : resolve());
    runtime = resolved.runtime;
  } catch (err) {
    observeCaughtError(err, "api/modules/service-terminal/service-terminal.controller");
    await activity?.release().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "api/modules/service-terminal/service-terminal.controller");
    });
    return {
      ok: false,
      code: "server_error",
      message: `Failed to resolve runtime: ${safeErrorMessage(err)}`,
    };
  }

  let handedOff = false;
  try {
    if (!runtime.supports("serviceShell") || !runtime.openServiceShell) {
      return {
        ok: false,
        code: "not_supported",
        message: `Terminal not supported on ${runtime.name} runtime`,
      };
    }

    // Resolve THIS service's own container via the shared resolver (never the
    // compose primary — see containerIdForService), then VERIFY it against the
    // host: a recorded id that a redeploy replaced would open a shell request on a
    // dead container and fail with docker's "no such container".
    const containerId = await liveContainerIdWithRuntime(runtime, {
      service: { id: service.id, name: service.name },
      projectId: project.id,
      slug: project.slug,
      tracked: await containerIdForService(dep, service),
    });
    if (!containerId) {
      return {
        ok: false,
        code: "not_deployed",
        message: "Service container not found — it may still be deploying.",
      };
    }

    // On the ok path the CALLER owns `runtime`: the WS handshake hands it to the
    // session (which disposes it when the session ends), and `issueTicket` — which
    // only wants the validation — releases it straight away.
    handedOff = true;
    if (!activity) return { ok: true, projectId: project.id, containerId, runtime };
    let releasing: Promise<void> | undefined;
    return {
      ok: true, projectId: project.id, containerId, runtime,
      openShell: () => activity!.run(() => runtime.openServiceShell!(containerId, {
        cols: 80, rows: 24, term: "xterm-256color",
      })),
      release: () => releasing ??= (async () => {
        disposeRuntime(runtime);
        await activity!.release();
      })(),
    };
  } finally {
    if (!handedOff) {
      disposeRuntime(runtime);
      await activity?.release();
    }
  }

}

// ─── Ticket endpoint ────────────────────────────────────────────────────────

export async function issueTicket(c: Context) {
  const ctx = getRequestContext(c);

  const body = await c.req.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/service-terminal/service-terminal.controller"); return ({} as Record<string, unknown>); });
  const serviceId = typeof (body as { serviceId?: unknown }).serviceId === "string"
    ? ((body as { serviceId: string }).serviceId)
    : "";
  if (!serviceId) return c.json({ error: "serviceId required" }, 400);
  const cloud = await prepareCloudTerminal(ctx, "service", serviceId);
  if (cloud) return c.json({ success: true, ...issueServiceTerminalTicket(ctx, serviceId, cloud) });

  // Surface 404 here so the dashboard can show a clear error without
  // burning an upgrade attempt. We deliberately do NOT precheck the
  // runtime / containerId at ticket time — those checks belong to the
  // WS open path, which can communicate a structured error frame.
  // Org-scoped + permission-gated — out-of-org / non-admin services 404
  // indistinguishably from missing.
  const result = await resolveServiceForOrg(serviceId, ctx);
  // This endpoint deliberately uses none of the runtime it just resolved (the WS
  // open path re-resolves and owns it), so release the transport immediately —
  // otherwise merely OPENING the terminal drawer leaked a bridge per ticket.
  if (result.ok) disposeRuntime(result.runtime);
  if (!result.ok && (result.code === "server_not_found" || result.code === "not_deployed")) {
    return c.json({ error: result.message }, 404);
  }

  const { token, expiresIn } = issueServiceTerminalTicket(ctx, serviceId);
  return c.json({ success: true, token, expiresIn });
}

// ─── WebSocket upgrade ──────────────────────────────────────────────────────

export const serviceTerminalWsHandler = upgradeWebSocket(async (c) => {
  // 1. Origin allowlist
  const origin = c.req.header("origin") ?? null;
  if (!isAllowedOrigin(origin)) {
    return openInitFailure("server_error", "Origin not allowed", 4403);
  }

  // 2. Subprotocol-based ticket auth (with cookie fallback).
  const protocols = (c.req.header("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tokenProto = protocols.find((p) => p.startsWith(SUBPROTOCOL_PREFIX));
  const token = tokenProto ? tokenProto.slice(SUBPROTOCOL_PREFIX.length) : "";
  const ticket = token ? consumeServiceTerminalTicket(token) : null;
  if (tokenProto && !ticket) return openInitFailure("ssh_auth", "Invalid or expired terminal ticket", 4401);

  const resumeProto = protocols.find((p) =>
    p.startsWith(RESUME_SUBPROTOCOL_PREFIX),
  );
  const resumeToken = resumeProto
    ? resumeProto.slice(RESUME_SUBPROTOCOL_PREFIX.length)
    : "";

  let actor;
  try {
    actor = await resolveTerminalContext(c.req.raw.headers, ticket?.context);
  } catch (error) {
    observeCaughtError(error, "api/lib/terminal-authorization");
    return openInitFailure("ssh_auth", "Unauthorized", 4401);
  }
  const { userId } = actor;

  // 3. Service existence + path binding
  const pathServiceId = c.req.param("serviceId");
  if (!pathServiceId)
    return openInitFailure("server_not_found", "serviceId required", 4400);
  if (ticket && ticket.serviceId !== pathServiceId) {
    return openInitFailure("ssh_auth", "Ticket / path mismatch", 4401);
  }
  if (ticket?.cloud) return cloudTerminalHandlers({ kind: "service", id: pathServiceId,
    context: ticket.context, cloud: ticket.cloud, resumeToken });

  // Resolve runtime + containerId. Org-scoped + admin-permission-gated
  // — refuses if the parent project doesn't belong to the caller's active
  // organization, OR if the caller lacks admin permission on the project
  // (opening a service shell is admin-tier).
  const resolved = await resolveServiceForOrg(pathServiceId, actor, !resumeToken);
  if (!resolved.ok) {
    const closeCode =
      resolved.code === "server_not_found"
        ? 4404
        : resolved.code === "not_deployed"
          ? 4404
          : resolved.code === "not_supported"
            ? 4400
            : 4500;
    return openInitFailure(resolved.code, resolved.message, closeCode);
  }

  let handedOff = false;
  try {
    // 4. Per-user concurrent cap (skip on resume).
    if (!resumeToken) {
      const inMem = countActiveServiceSessionsByUser(userId);
      if (inMem >= maxServiceSessionsPerUser()) {
        return openInitFailure("max_sessions", "Too many active sessions", 4429);
      }
      const dbCount = await repos.serviceTerminalSession.countActiveByUser(userId);
      if (dbCount >= maxServiceSessionsPerUser()) {
        return openInitFailure("max_sessions", "Too many active sessions", 4429);
      }
    }

    const clientIp = c.var.clientIp;
    const userAgent = c.req.header("user-agent") ?? null;

    const ctx: HandshakeCtx = {
      actor: ticket?.context ?? actor,
      userId,
      projectId: resolved.projectId,
      serviceId: pathServiceId,
      containerId: resolved.containerId,
      runtime: resolved.runtime,
      openShell: resolved.openShell,
      release: resolved.release,
      clientIp,
      userAgent,
      subprotocol: tokenProto,
      resumeToken,
    };

    const handlers = buildHandlers(ctx);
    handedOff = true;
    return handlers;
  } finally {
    if (!handedOff) {
      if (resolved.release) await resolved.release();
      else disposeRuntime(resolved.runtime);
    }
  }

});

// ─── Per-connection state ───────────────────────────────────────────────────

interface HandshakeCtx {
  projectId: string;
  actor: ExecutionContext;
  userId: string;
  serviceId: string;
  containerId: string;
  runtime: import("@repo/adapters").RuntimeAdapter;
  openShell?: () => Promise<ShellSession>;
  release?: () => Promise<void>;
  clientIp: string | null;
  userAgent: string | null;
  subprotocol: string | undefined;
  resumeToken: string;
}

export interface ConnState {
  ctx: HandshakeCtx;
  sessionId: string | null;
  shell: ShellSession | null;
  ws: WSLike | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  stopAuthorizationWatch?: () => void;
  /** True when this WebSocket connection has detached; stops its data pump and incoming messages. */
  closed: boolean;
  /** True when this connection's session has been fully ended (shell killed, audit row closed). */
  ended: boolean;
  userTerminated: boolean;
}

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
    ended: false,
    userTerminated: false,
  };

  function watchAuthorization(ws: WSLike) {
    state.stopAuthorizationWatch = watchTerminalAuthorization(ctx.actor, { resourceType: "project", resourceId: ctx.projectId }, () => {
      sendControl(ws, { type: "error", code: "ssh_auth", message: "Terminal authorization expired. Reconnect to continue." });
      state.userTerminated = true;
      safeWsClose(ws, 4401, "authorization_expired");
      void teardown(state, "client_close", null, false, true);
    });
  }

  return {
    async onOpen(_evt: unknown, ws: WSLike) {
      state.ws = ws;
      const dataPump = (chunk: Buffer) => {
        if (state.closed) return;
        safeWsSend(ws, chunk);
      };

      // RESUME path
      if (ctx.resumeToken) {
        // A resume reattaches to the PARKED session's existing shell, so the
        // runtime this handshake just resolved is never used — release it here
        // rather than at teardown, which would otherwise dispose this unused
        // handle and leave the one actually carrying the shell (owned by the
        // session) stranded.
        disposeRuntime(ctx.runtime);
        const existing = getServiceSessionByResumeToken(
          ctx.resumeToken,
          ctx.userId,
        );
        // A token cannot substitute a different service after permission checks.
        if (!existing || existing.serviceId !== ctx.serviceId) {
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
        attachServiceWs(existing.sessionId, dataPump);

        // Re-bind the timeout hook to this fresh WS/connection state so a
        // later idle or hard-cap timeout closes the session from the live
        // connection, not the stale parked one. Re-arm the idle timer so a
        // resume does not inherit an expiry from the original WS.
        existing.onTimeout = (_sid, reason) => {
          sendControl(ws, { type: "error", code: reason as ErrorCode, message: reason });
          safeWsClose(ws, 1011, reason);
          void teardown(state, reason, null, /* alreadyUnregistered */ true, /* forceClose */ true);
        };
        touchServiceSession(existing.sessionId);

        existing.shell.onClose((code: number | null, signal?: string) => {
          sendControl(ws, { type: "exit", code, signal });
          safeWsClose(ws, 1000, "remote_exit");
          void teardown(state, "remote_exit", code);
        });

        state.heartbeatTimer = setInterval(() => {
          sendControl(ws, { type: "pong" });
        }, HEARTBEAT_INTERVAL_MS);
        (state.heartbeatTimer as { unref?: () => void }).unref?.();
        watchAuthorization(ws);

        sendControl(ws, {
          type: "ready",
          sessionId: existing.sessionId,
          resumeToken: existing.resumeToken,
          resumed: true,
        });
        return;
      }

      // FRESH path
      let shell: ShellSession;
      let auditId: string | null = null;
      try {
        if (!ctx.runtime.openServiceShell) {
          throw new Error("Runtime does not implement openServiceShell");
        }
        shell = await (ctx.openShell?.() ?? ctx.runtime.openServiceShell(ctx.containerId, {
          cols: 80,
          rows: 24,
          term: "xterm-256color",
        }));
      } catch (err) {
        observeCaughtError(err, "api/modules/service-terminal/service-terminal.controller");
        const code: ErrorCode = "ssh_connect";
        sendControl(ws, {
          type: "error",
          code,
          message: safeErrorMessage(err),
        });
        safeWsClose(ws, 1011, code);
        // The shell never opened, so no session takes ownership of the runtime
        // below — release it here or a terminal that fails to attach leaks its
        // transport (the likeliest case being an unreachable host).
        if (ctx.release) await ctx.release().catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "api/modules/service-terminal/service-terminal.controller");
        });
        else disposeRuntime(ctx.runtime);
        return;
      }

      state.shell = shell;

      try {
        const row = await repos.serviceTerminalSession.open({
          userId: ctx.userId,
          serviceId: ctx.serviceId,
          clientIp: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        auditId = row.id;
      } catch {
        // eslint-disable-next-line no-console
        errorDiagnostics.error("api/modules/service-terminal/service-terminal.controller", "[service-terminal] failed to write audit open row");
      }

      const sessionId = auditId ?? `transient-${randomUUID()}`;
      const session = registerServiceSession({
        sessionId,
        userId: ctx.userId,
        serviceId: ctx.serviceId,
        shell,
        // Handed over: the session outlives this connection (park/resume), so it
        // is the only thing that knows when this transport is finished with.
        runtime: ctx.runtime,
        release: ctx.release,
        onTimeout: (_sid, reason) => {
          sendControl(ws, {
            type: "error",
            code: reason as ErrorCode,
            message: reason,
          });
          safeWsClose(ws, 1011, reason);
          void teardown(state, reason, null, true, true);
        },
      });
      state.sessionId = sessionId;

      // The WS can go away while we await the container shell and the
      // audit-row insert — @hono/node-ws registers its 'close' listener as
      // soon as this async onOpen suspends, so onClose runs against a state
      // that has no sessionId yet. The client never received `ready`, so it
      // holds no resumeToken and can never reattach: parking would strand the
      // shell and leave the audit row open forever, permanently burning a slot
      // in the per-user cap (which counts rows with endedAt IS NULL).
      if (state.closed) {
        unregisterServiceSession(sessionId);
        await teardown(
          state,
          "client_close",
          null,
          /* alreadyUnregistered */ true,
          /* forceClose */ true,
        );
        return;
      }

      attachServiceWs(sessionId, dataPump);
      shell.stdout.on("data", (chunk: Buffer) =>
        dispatchServiceStdout(sessionId, chunk),
      );
      shell.stderr.on("data", (chunk: Buffer) =>
        dispatchServiceStdout(sessionId, chunk),
      );

      shell.onClose((code: number | null, signal?: string) => {
        sendControl(ws, { type: "exit", code, signal });
        safeWsClose(ws, 1000, "remote_exit");
        void teardown(state, "remote_exit", code, false, true);
      });

      state.heartbeatTimer = setInterval(() => {
        sendControl(ws, { type: "pong" });
      }, HEARTBEAT_INTERVAL_MS);
      (state.heartbeatTimer as { unref?: () => void }).unref?.();
      watchAuthorization(ws);

      sendControl(ws, {
        type: "ready",
        sessionId,
        resumeToken: session.resumeToken,
        resumed: false,
      });
    },

    onMessage(evt: { data: unknown }, ws: WSLike) {
      if (state.closed || !state.shell) return;

      const data = evt.data;
      if (data instanceof ArrayBuffer) {
        if (state.sessionId) touchServiceSession(state.sessionId);
        safeShellWrite(state.shell, Buffer.from(data));
        return;
      }
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        if (state.sessionId) touchServiceSession(state.sessionId);
        safeShellWrite(state.shell, Buffer.from(data as Uint8Array));
        return;
      }
      if (typeof data === "string") {
        let msg: ControlIn;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg?.type === "resize") {
          const cols = clamp(Number(msg.cols), COLS_MIN, COLS_MAX);
          const rows = clamp(Number(msg.rows), ROWS_MIN, ROWS_MAX);
          state.shell.setWindow(cols, rows);
          return;
        }
        if (msg?.type === "ping") {
          if (state.sessionId) touchServiceSession(state.sessionId);
          sendControl(ws, { type: "pong" });
          return;
        }
        if (msg?.type === "close") {
          state.userTerminated = true;
          safeWsClose(ws, 1000, "client_terminate");
          return;
        }
      }
    },

    onClose() {
      void teardown(
        state,
        "client_close",
        null,
        false,
        state.userTerminated,
      );
    },

    onError() {
      void teardown(state, "client_close", null, false, false);
    },
  };
}

export function teardown(
  state: ConnState,
  reason: TerminalExitReason,
  exitCode: number | null,
  alreadyUnregistered = false,
  forceClose = true,
) {
  return trackBackgroundWork(
    teardownConnection(state, reason, exitCode, alreadyUnregistered, forceClose),
  );
}

async function teardownConnection(
  state: ConnState,
  reason: TerminalExitReason,
  exitCode: number | null,
  alreadyUnregistered: boolean,
  forceClose: boolean,
) {
  // Full teardown already completed for this connection.
  state.stopAuthorizationWatch?.();
  if (state.ended) return;

  // The WS side of this connection is already gone and this is not the
  // timeout/unregister path that intentionally runs after the WS detached.
  // This deflects stale shell.onClose callbacks from a previous WS after a
  // resume, while still allowing the idle/cap timeout to finalize the row.
  if (state.closed && !alreadyUnregistered) return;

  state.closed = true;

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  // No session registered yet: onOpen is still awaiting the container shell /
  // audit-row insert and owns the lifecycle of what it is about to create.
  // Marking this connection `ended` here would make onOpen's abort check —
  // and any later idle/cap timeout — a no-op, orphaning the audit row. Leave
  // `closed` set: that is the flag onOpen reads to abort.
  if (!state.sessionId) return;

  if (!forceClose) {
    parkServiceSession(state.sessionId);
    return;
  }

  // Force-close: this session is ending. Mark it now so any re-entrant
  // shell.onClose / onClose handler for this same connection no-ops.
  state.ended = true;

  if (state.shell) {
    safeShellClose(state.shell);
    state.shell = null;
  }

  if (!alreadyUnregistered && state.sessionId) {
    unregisterServiceSession(state.sessionId);
  }

  if (state.sessionId && !state.sessionId.startsWith("transient-")) {
    try {
      await repos.serviceTerminalSession.close(state.sessionId, {
        exitCode,
        exitReason: reason,
      });
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/modules/service-terminal/service-terminal.controller");
      // boot-time sweep will close orphaned rows
    }
  }
}

function sendControl(ws: WSLike, msg: ControlOut): void {
  safeWsSend(ws, JSON.stringify(msg));
}

function openInitFailure(code: ErrorCode, message: string, closeCode: number) {
  return {
    onOpen(_evt: unknown, ws: WSLike) {
      sendControl(ws, { type: "error", code, message });
      safeWsClose(ws, closeCode, code);
    },
    onMessage() {
      /* drop */
    },
    onClose() {
      /* nothing */
    },
    onError() {
      /* nothing */
    },
  };
}
