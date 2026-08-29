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

const server = vi.hoisted(() => ({
  getInOrganization: vi.fn(async (_serverId: string, _orgId: string) => null),
}));

vi.mock("@repo/db", () => ({ repos: { terminalSession, server } }));
vi.mock("../../../src/lib/ws", () => ({
  upgradeWebSocket: (fn: unknown) => fn,
}));
vi.mock("../../../src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: { retain: vi.fn(), release: vi.fn() },
}));
vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn() },
  checkPermission: vi.fn(async () => true),
}));
// The user's fallback org — what the WS path used to resolve to, and must
// no longer, when a ticket minted in a different org is presented.
vi.mock("../../../src/middleware/active-organization", () => ({
  resolveActiveOrganizationId: vi.fn(async () => "org_fallback"),
}));

import {
  teardown,
  terminalWsHandler,
  type ConnState,
} from "../../../src/modules/terminal/terminal.controller";
import { issueTerminalTicket } from "../../../src/lib/terminal-session-manager";
import { checkPermission } from "../../../src/lib/permission";
import { trustedOrigins } from "../../../src/config/env";
import type { RequestContext } from "../../../src/lib/request-context";

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

/** Minimal Hono-context stand-in for the WS upgrade factory. */
function fakeUpgradeContext(token: string, serverId: string) {
  const headers: Record<string, string> = {
    origin: trustedOrigins[0]!,
    "sec-websocket-protocol": `openship.terminal.v1+${token}`,
  };
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      param: (name: string) => (name === "serverId" ? serverId : undefined),
      raw: { headers: new Headers() },
    },
    var: { clientIp: null },
  };
}

describe("terminal.controller WS upgrade", () => {
  it("scopes the socket to the ticket's org, not the user's fallback org", async () => {
    // Ticket minted while the user was acting in org_ticket (the mint
    // endpoint runs under authMiddleware, so ctx.organizationId is real).
    const { token } = issueTerminalTicket(
      { userId: "user_1", organizationId: "org_ticket" } as RequestContext,
      "server_1",
    );
    server.getInOrganization.mockResolvedValue({
      id: "server_1",
    } as unknown as null);

    const handler = terminalWsHandler as unknown as (
      c: unknown,
    ) => Promise<unknown>;
    await handler(fakeUpgradeContext(token, "server_1"));

    // Both tenant gates must see the ticket's org. Resolving the org from
    // the user's memberships instead sends a member of several orgs to
    // whichever one sorts first, and every server outside it 404s.
    expect(checkPermission).toHaveBeenCalledWith("user_1", "org_ticket", {
      resourceType: "server",
      resourceId: "server_1",
      action: "admin",
    });
    expect(server.getInOrganization).toHaveBeenCalledWith(
      "server_1",
      "org_ticket",
    );
  });
});
