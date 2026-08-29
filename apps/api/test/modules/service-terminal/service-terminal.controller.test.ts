import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSession } from "@repo/adapters";

const serviceTerminalSession = vi.hoisted(() => {
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
    open: vi.fn(async (data: { userId: string; serviceId: string }) => {
      const id = `sts_${Math.random().toString(36).slice(2)}`;
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

vi.mock("@repo/db", () => ({ repos: { serviceTerminalSession } }));
vi.mock("../../../src/lib/ws", () => ({
  upgradeWebSocket: (fn: unknown) => fn,
}));
vi.mock("../../../src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

import {
  teardown,
  type ConnState,
} from "../../../src/modules/service-terminal/service-terminal.controller";

beforeEach(() => {
  serviceTerminalSession.reset();
  vi.clearAllMocks();
});

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

function makeConnState(
  userId: string,
  sessionId: string,
  shell: ShellSession,
): ConnState {
  return {
    ctx: {
      userId,
      serviceId: "test-service",
      containerId: "test-container",
      runtime: { name: "docker" } as ConnState["ctx"]["runtime"],
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

describe("service-terminal.controller teardown", () => {
  it("closes the audit row when a parked session is later force-closed by timeout", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { id: sessionId } = await serviceTerminalSession.open({
      userId,
      serviceId: "test-service",
    });
    const shell = fakeShell();
    const state = makeConnState(userId, sessionId, shell);

    // Browser disconnect parks the session.
    await teardown(state, "client_close", null, false, false);
    expect(state.closed).toBe(true);
    expect(state.ended).toBe(false);
    expect(serviceTerminalSession.close).not.toHaveBeenCalled();
    expect(await serviceTerminalSession.countActiveByUser(userId)).toBe(1);

    // Idle / hard-cap timeout fires after the session was unregistered.
    await teardown(state, "idle_timeout", null, true, true);

    expect(state.ended).toBe(true);
    expect(shell.close).toHaveBeenCalledOnce();
    expect(serviceTerminalSession.close).toHaveBeenCalledOnce();
    expect(serviceTerminalSession.close).toHaveBeenLastCalledWith(sessionId, {
      exitCode: null,
      exitReason: "idle_timeout",
    });
    expect(await serviceTerminalSession.countActiveByUser(userId)).toBe(0);
  });

  it("rejects stale shell.onClose from a previous WebSocket after a resume", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { id: sessionId } = await serviceTerminalSession.open({
      userId,
      serviceId: "test-service",
    });
    const shell = fakeShell();
    const state = makeConnState(userId, sessionId, shell);
    state.closed = true;

    await teardown(state, "remote_exit", 0, false, true);

    expect(state.ended).toBe(false);
    expect(shell.close).not.toHaveBeenCalled();
    expect(serviceTerminalSession.close).not.toHaveBeenCalled();
  });
});
