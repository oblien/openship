import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSession } from "@repo/adapters";

/**
 * The WS `close` listener is registered by @hono/node-ws as soon as onOpen
 * returns its (pending) promise — so a browser refresh / tab close lands in
 * onClose while onOpen is STILL awaiting the SSH channel and the audit-row
 * insert. These tests drive that interleaving through the real handler bundle.
 */

const terminalSession = vi.hoisted(() => {
  const rows = new Map<
    string,
    { userId: string; endedAt: Date | null; exitReason: string | null }
  >();

  return {
    open: vi.fn(async (data: { userId: string; serverId: string }) => {
      const id = `ts_${Math.random().toString(36).slice(2)}`;
      rows.set(id, { userId: data.userId, endedAt: null, exitReason: null });
      return { id };
    }),
    close: vi.fn(async (id: string, data: { exitReason: string }) => {
      const row = rows.get(id);
      if (row) {
        row.endedAt = new Date();
        row.exitReason = data.exitReason;
      }
    }),
    countActiveByUser: vi.fn(async (userId: string) => {
      return [...rows.values()].filter((r) => r.userId === userId && !r.endedAt)
        .length;
    }),
    reset: () => {
      rows.clear();
    },
  };
});

const sshManager = vi.hoisted(() => ({
  retain: vi.fn(),
  release: vi.fn(),
  withExecutor: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    terminalSession,
    server: { getInOrganization: vi.fn(async () => ({ id: "srv_1" })) },
  },
}));
vi.mock("../../../src/lib/ws", () => ({
  upgradeWebSocket: (fn: unknown) => fn,
}));
vi.mock("../../../src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock("../../../src/lib/ssh-manager", () => ({ sshManager }));
vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn(async () => {}) },
  checkPermission: vi.fn(async () => true),
}));
vi.mock("../../../src/middleware/active-organization", () => ({
  resolveActiveOrganizationId: vi.fn(async () => "org_1"),
}));

import { trustedOrigins } from "../../../src/config/env";
import { terminalWsHandler } from "../../../src/modules/terminal/terminal.controller";
import {
  countActiveSessionsByUser,
  getSessionByResumeToken,
  issueTerminalTicket,
  unregisterSession,
} from "../../../src/lib/terminal-session-manager";

interface Handlers {
  onOpen(evt: unknown, ws: unknown): Promise<void>;
  onMessage(evt: { data: unknown }, ws: unknown): void;
  onClose(): void;
  onError(): void;
}

// upgradeWebSocket is mocked to identity, so the export IS the handshake factory.
const handshake = terminalWsHandler as unknown as (c: unknown) => Promise<Handlers>;

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

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 };
}

function fakeCtx(token: string) {
  const headers = new Headers({
    origin: trustedOrigins[0]!,
    "sec-websocket-protocol": `openship.terminal.v1+${token}`,
  });
  return {
    req: {
      header: (name: string) => headers.get(name) ?? undefined,
      param: (name: string) => (name === "serverId" ? "srv_1" : undefined),
      raw: { headers },
    },
    var: { clientIp: "127.0.0.1" },
  };
}

/**
 * Start a handshake and suspend onOpen inside `openShell`. The returned
 * `openPty` resolves the SSH channel so onOpen can run to completion.
 */
async function startHandshake(userId: string) {
  const shell = fakeShell();
  let openPty!: () => void;
  const gate = new Promise<ShellSession>((resolve) => {
    openPty = () => resolve(shell);
  });
  sshManager.withExecutor.mockImplementation(
    async (_serverId: string, fn: (exec: unknown) => unknown) =>
      fn({ openShell: () => gate }),
  );

  const { token } = issueTerminalTicket(
    { userId, organizationId: "org_1" } as never,
    "srv_1",
  );
  const handlers = await handshake(fakeCtx(token));
  const ws = fakeWs();
  const opening = handlers.onOpen({}, ws);
  return { handlers, ws, shell, openPty, opening };
}

function readyFrame(ws: ReturnType<typeof fakeWs>) {
  for (const [payload] of ws.send.mock.calls) {
    if (typeof payload !== "string") continue;
    const msg = JSON.parse(payload);
    if (msg.type === "ready") return msg as { sessionId: string; resumeToken: string };
  }
  return null;
}

beforeEach(() => {
  terminalSession.reset();
  vi.clearAllMocks();
});

describe("terminal WS disconnect during session open", () => {
  it("finalizes the audit row when the browser disconnects while the PTY is opening", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { handlers, shell, openPty, opening } = await startHandshake(userId);

    // Browser refresh / tab close mid-handshake: onClose runs while onOpen is
    // still parked on the SSH channel.
    handlers.onClose();

    openPty();
    await opening;

    // The client never saw `ready` (no resumeToken), so nothing is resumable:
    // both the in-memory slot and the audit row must be reclaimed immediately.
    expect(countActiveSessionsByUser(userId)).toBe(0);
    expect(await terminalSession.countActiveByUser(userId)).toBe(0);
    expect(shell.close).toHaveBeenCalled();
    expect(sshManager.release).toHaveBeenCalledTimes(1);
  });

  it("still parks a fully-open session so a reconnect can resume it", async () => {
    const userId = `user_${Math.random().toString(36).slice(2)}`;
    const { handlers, ws, shell, openPty, opening } = await startHandshake(userId);

    openPty();
    await opening;
    const ready = readyFrame(ws);
    expect(ready).not.toBeNull();

    // Same abrupt disconnect, but after `ready` — the client holds a resume
    // token, so the shell + audit row stay alive for the idle window.
    handlers.onClose();

    expect(countActiveSessionsByUser(userId)).toBe(1);
    expect(await terminalSession.countActiveByUser(userId)).toBe(1);
    expect(getSessionByResumeToken(ready!.resumeToken, userId)).not.toBeNull();
    expect(shell.close).not.toHaveBeenCalled();

    unregisterSession(ready!.sessionId);
  });
});
