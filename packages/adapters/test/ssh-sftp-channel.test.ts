import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for #34: file ops must share ONE SFTP subsystem channel
// instead of opening (and leaking) a new one per call, which exhausted the
// server's MaxSessions and took the whole connection down mid-build.

vi.mock("../src/system/ssh-client", () => {
  // Required inside the factory: vi.mock is hoisted above the top-level import,
  // so the module-scope EventEmitter binding isn't initialized yet here.
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
  }
  class FakeSftp extends EventEmitter {
    writeFile(_p: string, _c: string, _o: unknown, cb: (e: Error | null) => void) {
      queueMicrotask(() => cb(null));
    }
    readFile(_p: string, _o: unknown, cb: (e: Error | null, d: Buffer) => void) {
      queueMicrotask(() => cb(null, Buffer.from("data")));
    }
    stat(_p: string, cb: (e: Error | null) => void) {
      queueMicrotask(() => cb(null));
    }
    end() {
      this.emit("close");
    }
  }
  class FakeClient extends EventEmitter {
    exec(_cmd: string, cb: (e: Error | null, s: FakeStream) => void) {
      const s = new FakeStream();
      cb(null, s);
      queueMicrotask(() => s.emit("close", 0));
    }
    end() {
      this.emit("close");
    }
    destroy() {
      this.emit("close");
    }
  }
  return {
    connectSshClient: vi.fn(async () => new FakeClient()),
    openSftp: vi.fn(async () => new FakeSftp()),
    openSshUnixSocket: vi.fn(),
  };
});

import { connectSshClient, openSftp } from "../src/system/ssh-client";
import { SshExecutor } from "../src/system/ssh-executor";

const openSftpMock = vi.mocked(openSftp);
const connectSshClientMock = vi.mocked(connectSshClient);

class ControlledSftp extends EventEmitter {
  writeFile = vi.fn(
    (_p: string, _c: string, _o: unknown, _cb: (error?: Error | null) => void) => {},
  );
  chmod = vi.fn((_p: string, _m: number, _cb: (error?: Error | null) => void) => {});
  readFile = vi.fn(
    (_p: string, _o: unknown, _cb: (error: Error | null, data: Buffer) => void) => {},
  );
  stat = vi.fn((_p: string, _cb: (error?: Error | null) => void) => {});
  end = vi.fn(() => this.emit("close"));
}

function makeExecutor() {
  return new SshExecutor({ host: "h", port: 22, username: "root", privateKey: "k" });
}

beforeEach(() => {
  openSftpMock.mockClear();
  connectSshClientMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SshExecutor SFTP channel reuse (#34)", () => {
  it("opens exactly one SFTP channel across many file ops", async () => {
    const exec = makeExecutor();
    await exec.writeFile("/tmp/a.txt", "x");
    await exec.readFile("/tmp/a.txt");
    await exec.exists("/tmp/a.txt");
    await exec.writeFile("/tmp/b.txt", "y");
    await exec.exists("/tmp/b.txt");

    expect(openSftpMock).toHaveBeenCalledTimes(1);
  });

  it("reopens the channel after it closes, but not before", async () => {
    const exec = makeExecutor();
    await exec.exists("/tmp/a.txt");
    expect(openSftpMock).toHaveBeenCalledTimes(1);

    // Simulate the channel dying (idle drop / server-side close): the cached
    // wrapper emits 'close', so the next op must open a fresh channel.
    const wrapper = (await openSftpMock.mock.results[0]!.value) as EventEmitter;
    wrapper.emit("close");

    await exec.exists("/tmp/a.txt");
    expect(openSftpMock).toHaveBeenCalledTimes(2);
  });
});

describe("SshExecutor bounded SFTP lifecycle", () => {
  it("cancels a read whose ssh2 callback is lost, closes it, and reopens for the next operation", async () => {
    const stuck = new ControlledSftp();
    openSftpMock.mockResolvedValueOnce(stuck as never);
    const executor = makeExecutor();
    const controller = new AbortController();

    const pending = executor.runWithAbortSignal(controller.signal, () =>
      executor.readFile("/etc/openship/state.json"),
    );
    await vi.waitFor(() => expect(stuck.readFile).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stuck.end).toHaveBeenCalledTimes(1);
    const lateReadCallback = stuck.readFile.mock.calls[0]![2];
    expect(() => lateReadCallback(null, Buffer.from("late"))).not.toThrow();
    await expect(executor.readFile("/etc/openship/state.json")).resolves.toBe("data");
    expect(openSftpMock).toHaveBeenCalledTimes(2);
  });

  it("cancels lost write, chmod, and stat callbacks instead of retaining the worker", async () => {
    const cases = [
      {
        name: "write",
        invoke: (executor: SshExecutor) => executor.writeFile("/tmp/config", "secret"),
        called: (sftp: ControlledSftp) => sftp.writeFile,
      },
      {
        name: "chmod",
        invoke: (executor: SshExecutor) => executor.writeFile("/tmp/config", "secret", { mode: 0o600 }),
        called: (sftp: ControlledSftp) => sftp.chmod,
        prepare: (sftp: ControlledSftp) => {
          sftp.writeFile.mockImplementationOnce((_p, _c, _o, cb) => queueMicrotask(() => cb(null)));
        },
      },
      {
        name: "stat",
        invoke: (executor: SshExecutor) => executor.exists("/tmp/config"),
        called: (sftp: ControlledSftp) => sftp.stat,
      },
    ];

    for (const testCase of cases) {
      const stuck = new ControlledSftp();
      testCase.prepare?.(stuck);
      openSftpMock.mockResolvedValueOnce(stuck as never);
      const executor = makeExecutor();
      const controller = new AbortController();
      const pending = executor.runWithAbortSignal(controller.signal, () => testCase.invoke(executor));
      await vi.waitFor(() => expect(testCase.called(stuck), testCase.name).toHaveBeenCalledTimes(1));

      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(stuck.end, testCase.name).toHaveBeenCalledTimes(1);
      await executor.dispose();
    }
  });

  it("cancels a lost SFTP-open callback by resetting the transport, then reconnects", async () => {
    let finishLateOpen!: (wrapper: ControlledSftp) => void;
    const late = new ControlledSftp();
    openSftpMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishLateOpen = resolve;
      }),
    );
    const executor = makeExecutor();
    const controller = new AbortController();
    const pending = executor.runWithAbortSignal(controller.signal, () => executor.exists("/tmp/a"));
    await vi.waitFor(() => expect(openSftpMock).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finishLateOpen(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.end).toHaveBeenCalledTimes(1);
    await expect(executor.exists("/tmp/a")).resolves.toBe(true);
    expect(connectSshClientMock).toHaveBeenCalledTimes(2);
    expect(openSftpMock).toHaveBeenCalledTimes(2);
  });

  it("force-resets the SSH transport when a cancelled SFTP channel will not close", async () => {
    vi.useFakeTimers();
    try {
      const stuck = new ControlledSftp();
      stuck.end.mockImplementation(() => undefined);
      openSftpMock.mockResolvedValueOnce(stuck as never);
      const executor = makeExecutor();
      const controller = new AbortController();
      const pending = executor.runWithAbortSignal(controller.signal, () =>
        executor.readFile("/tmp/stuck"),
      );

      for (let i = 0; i < 8 && stuck.readFile.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(stuck.readFile).toHaveBeenCalledTimes(1);
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await vi.advanceTimersByTimeAsync(750);

      await rejection;
      await expect(executor.exists("/tmp/next")).resolves.toBe(true);
      expect(connectSshClientMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a callback that never fires and closes its SFTP channel", async () => {
    vi.useFakeTimers();
    try {
      const stuck = new ControlledSftp();
      openSftpMock.mockResolvedValueOnce(stuck as never);
      const executor = makeExecutor();
      const pending = executor.readFile("/tmp/stuck");

      for (let i = 0; i < 8 && stuck.readFile.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(stuck.readFile).toHaveBeenCalledTimes(1);
      const rejection = expect(pending).rejects.toThrow(
        "SFTP read /tmp/stuck timed out after 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(stuck.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
