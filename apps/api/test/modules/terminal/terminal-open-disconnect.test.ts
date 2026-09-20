import "../mail/_setup-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSession } from "@repo/adapters";

const h = vi.hoisted(() => {
  const state = {
    auditGate: Promise.resolve(),
    auditStarted: () => {},
    auditFails: false,
    nextId: 0,
  };
  function repository(prefix: string) {
    const rows = new Map<string, { userId: string; ended: boolean }>();
    return {
      rows,
      open: vi.fn(async ({ userId }: { userId: string }) => {
        state.auditStarted();
        await state.auditGate;
        if (state.auditFails) throw new Error("audit unavailable");
        const id = `${prefix}-${++state.nextId}`;
        rows.set(id, { userId, ended: false });
        return { id };
      }),
      close: vi.fn(async (id: string) => {
        const row = rows.get(id);
        if (row) row.ended = true;
      }),
      countActiveByUser: vi.fn(
        async (userId: string) =>
          [...rows.values()].filter((r) => r.userId === userId && !r.ended).length,
      ),
    };
  }
  return {
    state,
    server: repository("server"),
    service: repository("service"),
    ssh: { retain: vi.fn(), release: vi.fn(), withExecutor: vi.fn() },
    openShell: vi.fn(),
    dispose: vi.fn(),
    resolveRuntime: vi.fn(),
    liveContainer: vi.fn(),
  };
});
vi.mock("@repo/db", () => ({
  repos: {
    terminalSession: h.server,
    serviceTerminalSession: h.service,
    server: { getInOrganization: vi.fn(async () => ({ id: "srv_1" })) },
    service: { findById: vi.fn(async () => ({ id: "svc_1", name: "web", projectId: "p1" })) },
    project: {
      findById: vi.fn(async () => ({
        id: "p1",
        organizationId: "org_1",
        activeDeploymentId: "d1",
      })),
    },
    deployment: {
      findById: vi.fn(async () => ({ id: "d1", projectId: "p1", organizationId: "org_1" })),
    },
  },
}));
vi.mock("../../../src/lib/ws", () => ({ upgradeWebSocket: (fn: unknown) => fn }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: h.ssh }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  checkPermission: vi.fn(async () => true),
}));
vi.mock("../../../src/middleware/active-organization", () => ({
  resolveActiveOrganizationId: vi.fn(async () => "org_1"),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: h.resolveRuntime,
  disposeRuntime: (runtime: { dispose?: () => void }) => runtime?.dispose?.(),
}));
vi.mock("@repo/platform/engine/modules/services/service-container", () => ({
  containerIdForService: vi.fn(async () => "cid"),
  liveContainerIdWithRuntime: h.liveContainer,
}));

import { trustedOrigins } from "@repo/platform/engine/config/env";
import { terminalWsHandler } from "../../../src/modules/terminal/terminal.controller";
import { serviceTerminalWsHandler } from "../../../src/modules/service-terminal/service-terminal.controller";
import {
  countActiveSessionsByUser,
  getSessionByResumeToken,
  issueTerminalTicket,
  unregisterSession,
} from "../../../src/lib/terminal-session-manager";
import {
  countActiveServiceSessionsByUser,
  getServiceSessionByResumeToken,
  issueServiceTerminalTicket,
  unregisterServiceSession,
} from "../../../src/lib/service-terminal-session-manager";

interface Handlers {
  onOpen(evt: unknown, ws: unknown): Promise<void>;
  onMessage(evt: { data: unknown }, ws: unknown): void;
  onClose(): void;
}
const kinds = [
  {
    name: "server",
    factory: terminalWsHandler,
    repo: h.server,
    mint: issueTerminalTicket,
    count: countActiveSessionsByUser,
    resume: getSessionByResumeToken,
    release: h.ssh.release,
  },
  {
    name: "service",
    factory: serviceTerminalWsHandler,
    repo: h.service,
    mint: issueServiceTerminalTicket,
    count: countActiveServiceSessionsByUser,
    resume: getServiceSessionByResumeToken,
    release: h.dispose,
  },
] as const;
type Kind = (typeof kinds)[number];
const ids = new Set<string>();
const connections: Handlers[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function start(
  kind: Kind,
  pause: "shell" | "audit" = "shell",
  userId = `user-${++h.state.nextId}`,
) {
  const shell = {
    close: vi.fn(),
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    setWindow: vi.fn(),
    onClose: vi.fn(),
  } as unknown as ShellSession;
  const pty = deferred<ShellSession>();
  const audit = deferred<void>();
  const atAudit = deferred<void>();
  h.state.auditStarted = () => atAudit.resolve();
  h.state.auditGate = pause === "audit" ? audit.promise : Promise.resolve();
  h.openShell.mockImplementation(() => (pause === "shell" ? pty.promise : Promise.resolve(shell)));
  const { token } = kind.mint(
    { userId, organizationId: "org_1" } as never,
    kind.name === "server" ? "srv_1" : "svc_1",
  );
  const headers = new Headers({
    origin: trustedOrigins[0]!,
    "sec-websocket-protocol": `openship.terminal.v1+${token}`,
  });
  const handlers = await (kind.factory as unknown as (ctx: unknown) => Promise<Handlers>)({
    req: {
      header: (name: string) => headers.get(name) ?? undefined,
      param: (name: string) => (name === "serverId" ? "srv_1" : "svc_1"),
      raw: { headers },
    },
    var: { clientIp: "127.0.0.1" },
  });
  connections.push(handlers);
  const frames: Array<{ type: string; sessionId?: string; resumeToken?: string; code?: string }> =
    [];
  const ws = {
    readyState: 1,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      const frame = JSON.parse(payload);
      frames.push(frame);
      if (frame.sessionId) ids.add(frame.sessionId);
    }),
  };
  const opening = handlers.onOpen({}, ws);
  return { userId, handlers, shell, ws, frames, opening, pty, audit, atAudit: atAudit.promise };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.server.rows.clear();
  h.service.rows.clear();
  h.state.auditFails = false;
  h.state.auditGate = Promise.resolve();
  h.ssh.withExecutor.mockImplementation(async (_id: string, fn: (executor: unknown) => unknown) =>
    fn({ openShell: h.openShell }),
  );
  h.resolveRuntime.mockResolvedValue({
    runtime: {
      name: "docker",
      supports: () => true,
      openServiceShell: h.openShell,
      dispose: h.dispose,
    },
  });
  h.liveContainer.mockResolvedValue("cid");
});
afterEach(() => {
  for (const connection of connections.splice(0)) connection.onClose();
  for (const id of [...ids, ...h.server.rows.keys(), ...h.service.rows.keys()]) {
    unregisterSession(id);
    unregisterServiceSession(id);
  }
  ids.clear();
  vi.restoreAllMocks();
});

describe.each(kinds)("$name terminal session ownership", (kind) => {
  it.each(["shell", "audit"] as const)(
    "reclaims an abandoned session while %s is pending",
    async (pause) => {
      const s = await start(kind, pause);
      if (pause === "audit") await s.atAudit;
      s.handlers.onClose();
      s.pty.resolve(s.shell);
      s.audit.resolve();
      await s.opening;
      expect(kind.count(s.userId)).toBe(0);
      expect(await kind.repo.countActiveByUser(s.userId)).toBe(0);
      expect(s.shell.close).toHaveBeenCalledTimes(1);
      expect(kind.release).toHaveBeenCalledTimes(1);
      expect(s.frames.some((frame) => frame.type === "ready")).toBe(false);
    },
  );
  it("still parks a ready session so a reconnect can resume it", async () => {
    const s = await start(kind);
    s.pty.resolve(s.shell);
    await s.opening;
    const ready = s.frames.find((frame) => frame.type === "ready")!;
    expect(ready).toBeDefined();
    s.handlers.onClose();
    expect(kind.count(s.userId)).toBe(1);
    expect(await kind.repo.countActiveByUser(s.userId)).toBe(1);
    expect(kind.resume(ready.resumeToken!, s.userId)).not.toBeNull();
    expect(s.shell.close).not.toHaveBeenCalled();
    expect(kind.release).not.toHaveBeenCalled();
  });
  it.each(["same", "different"])("binds a resume token to the %s authorized target", async (target) => {
    const s = await start(kind);
    s.pty.resolve(s.shell);
    await s.opening;
    const ready = s.frames.find((frame) => frame.type === "ready")!;
    s.handlers.onClose();

    const targetId = `${kind.name === "server" ? "srv" : "svc"}_${target === "same" ? 1 : 2}`;
    const { token } = kind.mint(
      { userId: s.userId, organizationId: "org_1" } as never,
      targetId,
    );
    const headers = new Headers({
      origin: trustedOrigins[0]!,
      "sec-websocket-protocol":
        `openship.terminal.v1+${token},openship.terminal.resume+${ready.resumeToken}`,
    });
    const handlers = await (kind.factory as unknown as (ctx: unknown) => Promise<Handlers>)({
      req: {
        header: (name: string) => headers.get(name) ?? undefined,
        param: () => targetId,
        raw: { headers },
      },
      var: { clientIp: "127.0.0.1" },
    });
    connections.push(handlers);
    const send = vi.fn();
    await handlers.onOpen({}, { readyState: 1, send, close: vi.fn() });

    const frames = send.mock.calls.map(([frame]) => JSON.parse(frame));
    if (target === "same") {
      expect(frames).toContainEqual(expect.objectContaining({
        type: "ready", resumed: true, sessionId: ready.sessionId,
      }));
    } else {
      expect(frames).toContainEqual(expect.objectContaining({ type: "error", code: "resume_failed" }));
      expect(frames.some((frame) => frame.type === "ready")).toBe(false);
    }
    expect(kind.resume(ready.resumeToken!, s.userId)).not.toBeNull();
    expect(s.shell.close).not.toHaveBeenCalled();
  });
  it("releases the transport when shell opening rejects after a disconnect", async () => {
    const s = await start(kind);
    s.handlers.onClose();
    s.pty.reject(new Error("shell unavailable"));
    await s.opening;
    expect(kind.count(s.userId)).toBe(0);
    expect(kind.repo.open).not.toHaveBeenCalled();
    expect(kind.release).toHaveBeenCalledTimes(1);
  });
  it("reclaims the transient session when the audit insert fails after disconnect", async () => {
    h.state.auditFails = true;
    const s = await start(kind, "audit");
    await s.atAudit;
    s.handlers.onClose();
    s.audit.resolve();
    await s.opening;
    expect(kind.count(s.userId)).toBe(0);
    expect(kind.release).toHaveBeenCalledTimes(1);
    expect(kind.repo.close).not.toHaveBeenCalled();
  });
  it("keeps simultaneous unaudited sessions distinct", async () => {
    h.state.auditFails = true;
    vi.spyOn(Date, "now").mockReturnValue(1800000000000);
    const a = await start(kind);
    a.pty.resolve(a.shell);
    await a.opening;
    const b = await start(kind);
    b.pty.resolve(b.shell);
    await b.opening;
    const first = a.frames.find((f) => f.type === "ready")!;
    const second = b.frames.find((f) => f.type === "ready")!;
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(kind.count(a.userId)).toBe(1);
    expect(kind.count(b.userId)).toBe(1);
  });
});

it("releases a service runtime rejected by the session cap", async () => {
  h.service.countActiveByUser.mockResolvedValueOnce(9999);
  const s = await start(kinds[1]);
  await s.opening;
  expect(s.frames).toContainEqual(expect.objectContaining({ type: "error", code: "max_sessions" }));
  expect(h.openShell).not.toHaveBeenCalled();
  expect(h.dispose).toHaveBeenCalledTimes(1);
});

it("releases a service runtime when reading the session cap fails", async () => {
  h.service.countActiveByUser.mockRejectedValueOnce(new Error("count unavailable"));
  await expect(start(kinds[1])).rejects.toThrow("count unavailable");
  expect(h.dispose).toHaveBeenCalledTimes(1);
});

it("releases a service runtime when checking the live container fails", async () => {
  h.liveContainer.mockRejectedValueOnce(new Error("container unavailable"));
  await expect(start(kinds[1])).rejects.toThrow("container unavailable");
  expect(h.dispose).toHaveBeenCalledTimes(1);
});
