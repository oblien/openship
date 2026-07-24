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

import type { Context } from "hono";
import { auth } from "../../lib/auth";
import { trustedOrigins } from "../../config/env";
import { upgradeWebSocket } from "../../lib/ws";
import { repos } from "@repo/db";
import type { ShellSession } from "@repo/adapters";
import type { TerminalExitReason } from "@repo/db";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { resolveActiveOrganizationId } from "../../middleware/active-organization";
import { checkPermission } from "../../lib/permission";
import { containerIdForService } from "../services/service-container";
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

const SUBPROTOCOL_PREFIX = "openship.terminal.v1+";
const RESUME_SUBPROTOCOL_PREFIX = "openship.terminal.resume+";
const HEARTBEAT_INTERVAL_MS = 25_000;
const COLS_MIN = 1, COLS_MAX = 1000;
const ROWS_MIN = 1, ROWS_MAX = 500;

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
 * so org-member terminals work for shared projects. NULL-org rows pass
 * via the `assertResourceInOrg`-style allowance.
 */
async function resolveServiceForOrg(
  serviceId: string,
  organizationId: string,
  userId: string,
): Promise<
  | { ok: true; containerId: string; runtime: import("@repo/adapters").RuntimeAdapter }
  | { ok: false; code: ErrorCode; message: string }
> {
  const service = await repos.service.findById(serviceId);
  if (!service) return { ok: false, code: "server_not_found", message: "Service not found" };

  // Primary gate: opening a service shell is admin-tier (full reach into
  // the container). We use the pure resolver because the WS upgrade path
  // doesn't carry a Hono context; the HTTP ticket path also calls this
  // helper, so funneling both through checkPermission keeps the gate in
  // one spot. 404-shape on deny — never confirm existence to non-admins.
  const allowed = await checkPermission(userId, organizationId, {
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
    (project.organizationId != null && project.organizationId !== organizationId)
  ) {
    // Same 404-shape as backup endpoints: don't leak existence vs.
    // authorization. NULL-org projects pass through for any caller —
    // same allowance assertResourceInOrg makes.
    return { ok: false, code: "server_not_found", message: "Service not found" };
  }

  if (!project.activeDeploymentId) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Project has no active deployment yet",
    };
  }
  const dep = await repos.deployment.findById(project.activeDeploymentId);
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
  try {
    const resolved = await resolveDeploymentRuntime({
      // A service is a CONTAINER, never the app's bare host process — pin the
      // docker runtime so the terminal targets the real service runtime (as
      // every other service action does via resolveServicePlatform), even when
      // the project's app itself deploys "bare".
      meta: { ...(dep.meta as Record<string, unknown> | null), runtimeMode: "docker" },
      organizationId: dep.organizationId,
    });
    runtime = resolved.runtime;
  } catch (err) {
    return {
      ok: false,
      code: "server_error",
      message: `Failed to resolve runtime: ${safeErrorMessage(err)}`,
    };
  }

  if (!runtime.supports("serviceShell") || !runtime.openServiceShell) {
    return {
      ok: false,
      code: "not_supported",
      message: `Terminal not supported on ${runtime.name} runtime`,
    };
  }

  // Resolve THIS service's own container via the shared resolver (never the
  // compose primary — see containerIdForService).
  const containerId = await containerIdForService(dep, service);
  if (!containerId) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Service container not found — it may still be deploying.",
    };
  }

  return { ok: true, containerId, runtime };
}

// ─── Ticket endpoint ────────────────────────────────────────────────────────

export async function issueTicket(c: Context) {
  const ctx = getRequestContext(c);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const serviceId = typeof (body as { serviceId?: unknown }).serviceId === "string"
    ? ((body as { serviceId: string }).serviceId)
    : "";
  if (!serviceId) return c.json({ error: "serviceId required" }, 400);

  // Surface 404 here so the dashboard can show a clear error without
  // burning an upgrade attempt. We deliberately do NOT precheck the
  // runtime / containerId at ticket time — those checks belong to the
  // WS open path, which can communicate a structured error frame.
  // Org-scoped + permission-gated — out-of-org / non-admin services 404
  // indistinguishably from missing.
  const result = await resolveServiceForOrg(serviceId, ctx.organizationId, ctx.userId);
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

  const resumeProto = protocols.find((p) =>
    p.startsWith(RESUME_SUBPROTOCOL_PREFIX),
  );
  const resumeToken = resumeProto
    ? resumeProto.slice(RESUME_SUBPROTOCOL_PREFIX.length)
    : "";

  let userId: string | null = null;
  let ticketServiceId: string | null = null;
  // not ctx-scoped: WebSocket upgrade path. Bypasses Hono auth
  // middleware, so identity is re-derived from scratch.
  //   - Ticket path: ticket carries (userId, orgId, serviceId) baked
  //     in at mint time → WS scopes against THAT org by construction.
  //   - Cookie path: no ticket → re-derive via session +
  //     resolveActiveOrganizationId (same resolver authMiddleware uses).
  let activeOrgId: string | null = null;
  if (ticket) {
    userId = ticket.userId;
    ticketServiceId = ticket.serviceId;
    activeOrgId = ticket.organizationId;
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
      /* fall through */
    }
  }
  if (!userId) return openInitFailure("ssh_auth", "Unauthorized", 4401);
  if (!activeOrgId) return openInitFailure("ssh_auth", "No active organization", 4401);

  // 3. Service existence + path binding
  const pathServiceId = c.req.param("serviceId");
  if (!pathServiceId)
    return openInitFailure("server_not_found", "serviceId required", 4400);
  if (ticketServiceId && ticketServiceId !== pathServiceId) {
    return openInitFailure("ssh_auth", "Ticket / path mismatch", 4401);
  }

  // Resolve runtime + containerId. Org-scoped + admin-permission-gated
  // — refuses if the parent project doesn't belong to the caller's active
  // organization, OR if the caller lacks admin permission on the project
  // (opening a service shell is admin-tier).
  const resolved = await resolveServiceForOrg(pathServiceId, activeOrgId, userId);
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
    userId,
    serviceId: pathServiceId,
    containerId: resolved.containerId,
    runtime: resolved.runtime,
    clientIp,
    userAgent,
    subprotocol: tokenProto,
    resumeToken,
  };

  return buildHandlers(ctx);
});

// ─── Per-connection state ───────────────────────────────────────────────────

interface HandshakeCtx {
  userId: string;
  serviceId: string;
  containerId: string;
  runtime: import("@repo/adapters").RuntimeAdapter;
  clientIp: string | null;
  userAgent: string | null;
  subprotocol: string | undefined;
  resumeToken: string;
}

interface ConnState {
  ctx: HandshakeCtx;
  sessionId: string | null;
  shell: ShellSession | null;
  ws: WSLike | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  closed: boolean;
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
    userTerminated: false,
  };

  return {
    async onOpen(_evt: unknown, ws: WSLike) {
      state.ws = ws;
      const dataPump = (chunk: Buffer) => {
        if (state.closed) return;
        safeWsSend(ws, chunk);
      };

      // RESUME path
      if (ctx.resumeToken) {
        const existing = getServiceSessionByResumeToken(
          ctx.resumeToken,
          ctx.userId,
        );
        if (!existing) {
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

      // FRESH path
      let shell: ShellSession;
      let auditId: string | null = null;
      try {
        if (!ctx.runtime.openServiceShell) {
          throw new Error("Runtime does not implement openServiceShell");
        }
        shell = await ctx.runtime.openServiceShell(ctx.containerId, {
          cols: 80,
          rows: 24,
          term: "xterm-256color",
        });
      } catch (err) {
        const code: ErrorCode = "ssh_connect";
        sendControl(ws, {
          type: "error",
          code,
          message: safeErrorMessage(err),
        });
        safeWsClose(ws, 1011, code);
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
        console.error("[service-terminal] failed to write audit open row");
      }

      const sessionId = auditId ?? `transient-${Date.now()}`;
      const session = registerServiceSession({
        sessionId,
        userId: ctx.userId,
        serviceId: ctx.serviceId,
        shell,
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

  if (!forceClose && state.sessionId) {
    parkServiceSession(state.sessionId);
    return;
  }

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
    } catch {
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
