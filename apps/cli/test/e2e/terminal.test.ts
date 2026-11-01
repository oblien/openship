import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalOptions, TerminalSession } from "@repo/sdk/client";
import { setJsonMode } from "../../src/lib/output";

const terminal = vi.hoisted(() => ({ openServer: vi.fn(), openService: vi.fn() }));
vi.mock("../../src/lib/ship-client", () => ({ getRemoteClient: () => ({ terminal }) }));
vi.mock("../../src/lib/config", () => ({
  getDashboardUrl: () => "https://dashboard.example.test",
}));
import { openTerminal } from "../../src/lib/terminal";

const originals: Array<() => void> = [];
function property(object: object, name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  originals.push(() => {
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else Reflect.deleteProperty(object, name);
  });
  Object.defineProperty(object, name, { value, writable: true, configurable: true });
}
let raw: ReturnType<typeof vi.fn>;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  exitCode = process.exitCode;
  setJsonMode(false);
  property(process.stdin, "isTTY", true);
  property(process.stdout, "isTTY", true);
  property(process.stdin, "isRaw", false);
  raw = vi.fn();
  property(process.stdin, "setRawMode", raw);
  vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const restore of originals.splice(0).reverse()) restore();
  setJsonMode(false);
  process.exitCode = exitCode;
});

function session(closed = Promise.resolve({ type: "exit" as const, code: 7 })): TerminalSession {
  return {
    type: "ready",
    sessionId: "session-fixture",
    resumeToken: "not-printed",
    resumed: false,
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    closed,
  };
}

describe("CLI terminal ownership and cleanup", () => {
  it("uses the saved dashboard origin, preserves the shell exit code and restores TTY state", async () => {
    const current = session();
    terminal.openServer.mockResolvedValue(current);
    const inputs = process.stdin.listenerCount("data");
    const resizes = process.stdout.listenerCount("resize");
    await openTerminal({ kind: "server", id: "server-fixture" }, {});
    expect(terminal.openServer).toHaveBeenCalledWith(
      "server-fixture",
      expect.objectContaining({ origin: "https://dashboard.example.test" }),
    );
    expect(process.exitCode).toBe(7);
    expect(raw.mock.calls).toEqual([[true], [false]]);
    expect(current.close).toHaveBeenCalledOnce();
    expect(process.stdin.listenerCount("data")).toBe(inputs);
    expect(process.stdout.listenerCount("resize")).toBe(resizes);
  });

  it("restores the terminal and signal listeners when opening fails", async () => {
    terminal.openService.mockRejectedValue(new Error("Service administration required"));
    const signals = process.listenerCount("SIGTERM");
    await expect(openTerminal({ kind: "service", id: "service-fixture" }, {})).rejects.toThrow(
      "administration required",
    );
    expect(raw).toHaveBeenCalledWith(false);
    expect(process.listenerCount("SIGTERM")).toBe(signals);
  });

  it("terminates a session and restores raw mode on local process interruption", async () => {
    let reject!: (error: unknown) => void;
    const current = session(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    let connected!: () => void;
    const opened = new Promise<void>((resolve) => {
      connected = resolve;
    });
    terminal.openServer.mockImplementation(async (_id: string, options: TerminalOptions) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
        once: true,
      });
      connected();
      return current;
    });
    const originalSignals = new Set(process.listeners("SIGTERM"));
    const running = openTerminal({ kind: "server", id: "server-fixture" }, {});
    await opened;
    const stop = process.listeners("SIGTERM").find((listener) => !originalSignals.has(listener))!;
    stop("SIGTERM");
    await running;
    expect(process.exitCode).toBe(143);
    expect(raw).toHaveBeenLastCalledWith(false);
    expect(current.close).toHaveBeenCalledOnce();
  });

  it("rejects JSON-mode terminal requests before minting credentials", async () => {
    setJsonMode(true);
    await expect(openTerminal({ kind: "server", id: "server-fixture" }, {})).rejects.toThrow(
      "server exec",
    );
    expect(terminal.openServer).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
  });
});
