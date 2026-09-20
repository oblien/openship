// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePtyConnection, type PtyConnection, type PtyTarget } from "./usePtyConnection";

const { ticket, wsUrl } = vi.hoisted(() => ({ ticket: vi.fn(), wsUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({
  requestTerminalTicket: ticket,
  requestServiceTerminalTicket: ticket,
  buildTerminalWsUrl: wsUrl,
  buildServiceTerminalWsUrl: wsUrl,
  TERMINAL_SUBPROTOCOL_PREFIX: "openship.terminal.v1+",
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX: "openship.terminal.resume+",
}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 2;
  });
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    Socket.instances.push(this);
  }
  ready() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
    this.onmessage?.({
      data: JSON.stringify({
        type: "ready",
        sessionId: "session",
        resumeToken: "resume",
        resumed: false,
      }),
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let connection: PtyConnection;
const onError = vi.fn();
const onBytes = vi.fn();
function Harness({ target }: { target: PtyTarget | null }) {
  connection = usePtyConnection({ target, enabled: true, onBytes, onError });
  return null;
}
async function render(target: PtyTarget | null) {
  await act(async () => root.render(<Harness target={target} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  ticket.mockReset().mockImplementation(async (id: string) => ({ token: id }));
  wsUrl.mockReset().mockImplementation((id: string) => `ws://localhost:4000/terminal/${id}`);
  onError.mockReset();
  onBytes.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("terminal connection ownership (#668)", () => {
  it.each(["server", "service"] as const)(
    "waits for a ready frame from the %s shell",
    async (kind) => {
      await render({ kind, id: "current" });
      expect(connection.isConnecting).toBe(true);
      expect(connection.isConnected).toBe(false);
      await act(async () => Socket.instances[0].ready());
      expect(connection.isConnected).toBe(true);
      expect(connection.isConnecting).toBe(false);
      connection.sendInput("hello");
      expect(Socket.instances[0].send).toHaveBeenCalledWith(new TextEncoder().encode("hello"));
    },
  );

  it("reconnects the current target when the hook initially had no target", async () => {
    await render(null);
    await render({ kind: "service", id: "current" });
    await act(async () => Socket.instances[0].onclose?.({ code: 1006 }));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(ticket.mock.calls.map(([id]) => id)).toEqual(["current", "current"]);
    expect(Socket.instances).toHaveLength(2);
  });

  it("ignores a ticket that finishes after switching targets", async () => {
    const stale = deferred<{ token: string }>();
    ticket.mockReturnValueOnce(stale.promise);
    await render({ kind: "server", id: "old" });
    await render({ kind: "service", id: "new" });
    await act(async () => Socket.instances[0].ready());
    await act(async () => stale.resolve({ token: "old" }));
    expect(Socket.instances.map((socket) => socket.url)).toEqual([
      "ws://localhost:4000/terminal/new",
    ]);
    expect(connection.isConnected).toBe(true);
  });

  it("ignores late close, error and data events from a replaced socket", async () => {
    await render({ kind: "server", id: "old" });
    const old = Socket.instances[0];
    await render({ kind: "server", id: "new" });
    const current = Socket.instances[1];
    await act(async () => current.ready());
    await act(async () => {
      old.onclose?.({ code: 1006 });
      old.onerror?.();
      old.onmessage?.({ data: new ArrayBuffer(4) });
    });
    expect(connection.isConnected).toBe(true);
    expect(connection.lastError).toBeNull();
    expect(onBytes).not.toHaveBeenCalled();
    connection.sendInput("still current");
    expect(current.send).toHaveBeenCalledOnce();
  });

  it("ignores an old ticket rejection after a fresh connection succeeds", async () => {
    const stale = deferred<{ token: string }>();
    ticket.mockReturnValueOnce(stale.promise);
    await render({ kind: "server", id: "old" });
    await render({ kind: "server", id: "new" });
    await act(async () => Socket.instances[0].ready());
    await act(async () => stale.reject(new Error("old request failed")));
    expect(connection.isConnected).toBe(true);
    expect(connection.lastError).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["ticket", "shell"])(
    "reports a stalled %s handshake and rejects late completion",
    async (stage) => {
      const pending = deferred<{ token: string }>();
      if (stage === "ticket") ticket.mockReturnValueOnce(pending.promise);
      await render({ kind: "service", id: "slow" });
      const socket = Socket.instances[0];
      if (socket)
        await act(async () => {
          socket.readyState = 1;
          socket.onopen?.();
        });
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(connection.isConnecting).toBe(false);
      expect(connection.lastError).toBe("ssh_connect");
      expect(onError).toHaveBeenCalledWith("ssh_connect", expect.stringMatching(/timed out/i));
      await act(async () => {
        pending.resolve({ token: "late" });
        socket?.ready();
      });
      expect(connection.isConnected).toBe(false);
      expect(Socket.instances).toHaveLength(stage === "ticket" ? 0 : 1);
      if (socket) expect(socket.close).toHaveBeenCalled();
    },
  );

  it("clears the handshake deadline once ready and cancels retries on unmount", async () => {
    await render({ kind: "server", id: "current" });
    await act(async () => Socket.instances[0].ready());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(connection.isConnected).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    await act(async () => Socket.instances[0].onclose?.({ code: 1006 }));
    await render(null);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(ticket).toHaveBeenCalledOnce();
  });
});
