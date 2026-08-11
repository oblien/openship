import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSession } from "@repo/adapters";

const terminalSession = vi.hoisted(() => {
  const rows = new Map<
    string,
    {
      userId: string;
      endedAt: Date | null;
      exitCode: number | null;
      exitReason: string | null;
    }
  >();

  return {
    open: vi.fn(async (data: { userId: string; serverId: string }) => {
      const id = `ts_${Math.random().toString(36).slice(2)}`;
      rows.set(id, {
        userId: data.userId,
        endedAt: null,
        exitCode: null,
        exitReason: null,
      });
      return { id };
    }),
    close: vi.fn(
      async (
        id: string,
        data: { exitCode?: number | null; exitReason: string },
      ) => {
        const row = rows.get(id);
        if (row) {
          row.endedAt = new Date();
          row.exitCode = data.exitCode ?? null;
          row.exitReason = data.exitReason;
        }
      },
    ),
    countActiveByUser: vi.fn(async (userId: string) => {
      return [...rows.values()].filter((r) => r.userId === userId && !r.endedAt)
        .length;
    }),
    reset: () => {
      rows.clear();
    },
  };
});

vi.mock("@repo/db", () => ({ repos: { terminalSession } }));
vi.mock("../../../src/lib/ws", () => ({
  upgradeWebSocket: (fn: unknown) => fn,
}));
vi.mock("../../../src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: { retain: vi.fn(), release: vi.fn() },
}));

import { teardown, type ConnState } from "../../../src/modules/terminal/terminal.controller";

function fakeShell(): ShellSession {
  return {
    close: vi.fn(),
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    setWindow: vi.fn(),
    onClose: vi.fn(),
  } as unknown as ShellSession;
}

beforeEach(() => {
  terminalSession.reset();
  vi.clearAllMocks();
});

function makeConnState(
  userId: string,
  sessionId: string,
  shell: ShellSession,
): ConnState {
  return {
    ctx: {
      userId,
      serverId: "test-server",
      clientIp: null,
      userAgent: null,
      subprotocol: undefined,
      resumeToken: "",
    } as ConnState["ctx"],
    sessionId,
    shell,
    ws: { send: vi.fn(), close: vi.fn() },
    heartbeatTimer: null,
    closed: false,
    ended: false,
    userTerminated: false,
  };
}

describe("terminal.controller teardown", () => {
  it("closes the audit row when a parked session is later force-closed by timeout", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { id: sessionId } = await terminalSession.open({
      userId,
      serverId: "test-server",
    });
    const shell = fakeShell();
    const state = makeConnState(userId, sessionId, shell);

    // 1. Browser disconnect parks the session. This sets state.closed but
    //    deliberately does not close the audit row, so the user can resume.
    await teardown(state, "client_close", null, false, false);
    expect(state.closed).toBe(true);
    expect(state.ended).toBe(false);
    expect(terminalSession.close).not.toHaveBeenCalled();
    expect(await terminalSession.countActiveByUser(userId)).toBe(1);

    // 2. Idle / hard-cap timeout fires. fireTimeout has already unregistered
    //    the session, so it calls teardown with alreadyUnregistered=true. The
    //    fix ensures this still finalizes the DB row even though state.closed
    //    is already true from the earlier park.
    await teardown(state, "idle_timeout", null, true, true);

    expect(state.ended).toBe(true);
    expect(shell.close).toHaveBeenCalledOnce();
    expect(terminalSession.close).toHaveBeenCalledOnce();
    expect(terminalSession.close).toHaveBeenLastCalledWith(sessionId, {
      exitCode: null,
      exitReason: "idle_timeout",
    });
    expect(await terminalSession.countActiveByUser(userId)).toBe(0);
  });

  it("rejects stale shell.onClose from a previous WebSocket after a resume", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { id: sessionId } = await terminalSession.open({
      userId,
      serverId: "test-server",
    });
    const shell = fakeShell();
    const state = makeConnState(userId, sessionId, shell);
    state.closed = true; // the old WS was parked

    // A stale shell.onClose callback from the old connection must not close
    // the audit row for a session that has since resumed on a new WS.
    await teardown(state, "remote_exit", 0, false, true);

    expect(state.ended).toBe(false);
    expect(shell.close).not.toHaveBeenCalled();
    expect(terminalSession.close).not.toHaveBeenCalled();
  });

  it("is idempotent when force-close is triggered twice", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { id: sessionId } = await terminalSession.open({
      userId,
      serverId: "test-server",
    });
    const shell = fakeShell();
    const state = makeConnState(userId, sessionId, shell);

    await teardown(state, "remote_exit", 0, false, true);
    expect(state.ended).toBe(true);
    expect(terminalSession.close).toHaveBeenCalledOnce();

    // A second call (e.g. onClose after shell exit) must not re-close the row.
    await teardown(state, "client_close", null, false, true);
    expect(terminalSession.close).toHaveBeenCalledOnce();
  });
});
