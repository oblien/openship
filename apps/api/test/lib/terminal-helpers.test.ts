import { describe, expect, it, vi } from "vitest";
import {
  safeWsSend,
  safeWsClose,
  safeShellWrite,
  safeShellClose,
  type WSLike,
  type ShellLike,
} from "../../src/lib/terminal-helpers";

function fakeWs(): WSLike {
  return { send: vi.fn(), close: vi.fn() };
}

function fakeShell(): ShellLike {
  return { stdin: { write: vi.fn() }, close: vi.fn() };
}

describe("safeWsSend", () => {
  it("sends data when ws is open", () => {
    const ws = fakeWs();
    safeWsSend(ws, "hello");
    expect(ws.send).toHaveBeenCalledWith("hello");
  });

  it("sends binary data", () => {
    const ws = fakeWs();
    const buf = new Uint8Array([1, 2, 3]);
    safeWsSend(ws, buf);
    expect(ws.send).toHaveBeenCalledWith(buf);
  });

  it("does not throw when ws.send throws", () => {
    const ws = fakeWs();
    ws.send = vi.fn(() => { throw new Error("peer gone"); });
    expect(() => safeWsSend(ws, "data")).not.toThrow();
  });
});

describe("safeWsClose", () => {
  it("closes ws with code and reason", () => {
    const ws = fakeWs();
    safeWsClose(ws, 1000, "normal");
    expect(ws.close).toHaveBeenCalledWith(1000, "normal");
  });

  it("closes ws with code only", () => {
    const ws = fakeWs();
    safeWsClose(ws, 1011);
    expect(ws.close).toHaveBeenCalledWith(1011, undefined);
  });

  it("does not throw when ws.close throws", () => {
    const ws = fakeWs();
    ws.close = vi.fn(() => { throw new Error("already closing"); });
    expect(() => safeWsClose(ws, 1000)).not.toThrow();
  });
});

describe("safeShellWrite", () => {
  it("writes buffer to shell stdin", () => {
    const shell = fakeShell();
    const buf = Buffer.from("data");
    safeShellWrite(shell, buf);
    expect(shell.stdin.write).toHaveBeenCalledWith(buf);
  });

  it("does not throw when stdin.write throws", () => {
    const shell = fakeShell();
    shell.stdin.write = vi.fn(() => { throw new Error("shell gone"); });
    expect(() => safeShellWrite(shell, Buffer.from("x"))).not.toThrow();
  });

  it("does not throw when stdin is null (type safety)", () => {
    const shell = { stdin: { write: vi.fn(() => { throw new Error("missing"); }) } };
    expect(() => safeShellWrite(shell, Buffer.from("x"))).not.toThrow();
  });
});

describe("safeShellClose", () => {
  it("closes the shell", () => {
    const shell = fakeShell();
    safeShellClose(shell);
    expect(shell.close).toHaveBeenCalled();
  });

  it("does not throw when shell.close throws", () => {
    const shell = fakeShell();
    shell.close = vi.fn(() => { throw new Error("best-effort"); });
    expect(() => safeShellClose(shell)).not.toThrow();
  });
});
