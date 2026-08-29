import { describe, expect, it, vi } from "vitest";

import {
  type ShellLike,
  type WSLike,
  safeShellClose,
  safeShellWrite,
  safeWsClose,
  safeWsSend,
} from "../../src/lib/terminal-helpers";

// The whole point of these wrappers is that a dead peer must not throw into the
// terminal stream plumbing, so every case here asserts both "forwards the call"
// and "swallows the throw".
const fakeWs = (): WSLike => ({ send: vi.fn(), close: vi.fn() });
const fakeShell = (): ShellLike => ({ stdin: { write: vi.fn() }, close: vi.fn() });

describe("safeWsSend", () => {
  it("forwards text and binary payloads unchanged", () => {
    const ws = fakeWs();
    const bin = new Uint8Array([1, 2, 3]);
    safeWsSend(ws, "hello");
    safeWsSend(ws, bin);
    expect(ws.send).toHaveBeenNthCalledWith(1, "hello");
    expect(ws.send).toHaveBeenNthCalledWith(2, bin);
  });

  it("swallows a send on a gone peer", () => {
    const ws = fakeWs();
    ws.send = vi.fn(() => {
      throw new Error("peer gone");
    });
    expect(() => safeWsSend(ws, "data")).not.toThrow();
  });
});

describe("safeWsClose", () => {
  it("passes through code and reason", () => {
    const ws = fakeWs();
    safeWsClose(ws, 1000, "normal");
    expect(ws.close).toHaveBeenCalledWith(1000, "normal");
  });

  it("passes undefined reason when omitted", () => {
    const ws = fakeWs();
    safeWsClose(ws, 1011);
    expect(ws.close).toHaveBeenCalledWith(1011, undefined);
  });

  it("swallows a close on an already-closing socket", () => {
    const ws = fakeWs();
    ws.close = vi.fn(() => {
      throw new Error("already closing");
    });
    expect(() => safeWsClose(ws, 1000)).not.toThrow();
  });

  it("stays quiet when called twice", () => {
    const ws = fakeWs();
    safeWsClose(ws, 1000);
    expect(() => safeWsClose(ws, 1000)).not.toThrow();
    expect(ws.close).toHaveBeenCalledTimes(2);
  });
});

describe("safeShellWrite", () => {
  it("writes the buffer to shell stdin", () => {
    const shell = fakeShell();
    const buf = Buffer.from("data");
    safeShellWrite(shell, buf);
    expect(shell.stdin.write).toHaveBeenCalledWith(buf);
  });

  it("swallows a write to a dead shell", () => {
    const shell = fakeShell();
    shell.stdin.write = vi.fn(() => {
      throw new Error("shell gone");
    });
    expect(() => safeShellWrite(shell, Buffer.from("x"))).not.toThrow();
  });
});

describe("safeShellClose", () => {
  it("closes the shell", () => {
    const shell = fakeShell();
    safeShellClose(shell);
    expect(shell.close).toHaveBeenCalledTimes(1);
  });

  it("swallows a close error (best-effort teardown)", () => {
    const shell = fakeShell();
    shell.close = vi.fn(() => {
      throw new Error("best-effort");
    });
    expect(() => safeShellClose(shell)).not.toThrow();
  });
});
