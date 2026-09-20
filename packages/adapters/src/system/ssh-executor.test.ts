import { EventEmitter } from "node:events";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `streamExec`'s abort path is the transport half of the server-logs fix: a disconnected
 * browser tears down the SSE relay, and the signal has to reach the ssh2 channel so the
 * remote `docker exec curl` gets an EPIPE and dies — otherwise it lingers to pipe_stream's
 * 1h cap, holding an SSH session. These tests pin the two things that make that safe:
 * closing the channel on abort, and settling BEFORE the close (so the channel's own
 * data-less 'close' event doesn't win the race and reject with "no exit status").
 */

const connectSshClient = vi.fn();
vi.mock("./ssh-client", () => ({
  connectSshClient: (...args: unknown[]) => connectSshClient(...args),
  openSftp: vi.fn(),
  openSshUnixSocket: vi.fn(),
}));

import { SshExecutor } from "./ssh-executor";

/** A stand-in for an ssh2 ClientChannel: an EventEmitter with a `.stderr` sub-emitter and
 *  a `.close()` that behaves like the real one — a data-less 'close' with no exit code,
 *  which the non-abort path treats as a mid-command teardown. */
class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  close = vi.fn(() => {
    // Real ssh2 fires 'close' asynchronously after close(); do it synchronously here to
    // maximise the chance of losing the settle race if the ordering were wrong.
    this.emit("close", null);
  });
}

function fakeClient(onExec: (cmd: string, cb: (err: Error | null, ch: FakeChannel) => void) => void) {
  const client = new EventEmitter() as EventEmitter & {
    exec: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  client.exec = vi.fn(onExec);
  client.end = vi.fn(() => client.emit("close"));
  client.destroy = vi.fn(() => client.emit("close"));
  return client;
}

const CONFIG = { host: "h", username: "u", privateKey: "k" };

/** connect() is async, so exec (and the listener wiring inside it) runs a few microtasks
 *  after streamExec is called. Emitting channel events before that would hit no listeners.
 *  waitFor retries until the exec callback has fired. */
const untilExec = (client: ReturnType<typeof fakeClient>) =>
  vi.waitFor(() => {
    if (!client.exec.mock.calls.length) throw new Error("exec not called yet");
  });

const untilExecCount = (client: ReturnType<typeof fakeClient>, count: number) =>
  vi.waitFor(() => {
    if (client.exec.mock.calls.length < count) {
      throw new Error(`exec called ${client.exec.mock.calls.length}/${count} times`);
    }
  });

beforeEach(() => {
  connectSshClient.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("streamExec abort", () => {
  it("closes the channel and resolves (not rejects) when the signal fires mid-stream", async () => {
    const channel = new FakeChannel();
    const client = fakeClient((_cmd, cb) => cb(null, channel));
    connectSshClient.mockResolvedValue(client);

    const controller = new AbortController();
    const ex = new SshExecutor(CONFIG);
    const p = ex.streamExec("curl -fsSN http://x/logs/stream", () => {}, {
      signal: controller.signal,
    });

    await untilExec(client);
    // A byte arrives, then the browser goes away.
    channel.emit("data", Buffer.from("event: request\ndata: {}\n\n"));
    controller.abort();

    const result = await p;
    // Settled as an intentional stop, carrying the bytes that did arrive — NOT rejected by
    // the data-less 'close' that our close() emits.
    expect(result.code).toBe(0);
    expect(result.output).toContain("event: request");
    expect(channel.close).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately without opening a channel if already aborted", async () => {
    const client = fakeClient(() => {
      throw new Error("exec must not be called for a pre-aborted signal");
    });
    connectSshClient.mockResolvedValue(client);

    const ex = new SshExecutor(CONFIG);
    const result = await ex.streamExec("curl", () => {}, {
      signal: AbortSignal.abort(),
    });

    expect(result).toEqual({ code: 0, output: "" });
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("still resolves normally on a real exit when no signal is passed", async () => {
    const channel = new FakeChannel();
    const client = fakeClient((_cmd, cb) => cb(null, channel));
    connectSshClient.mockResolvedValue(client);

    const ex = new SshExecutor(CONFIG);
    const p = ex.streamExec("echo hi", () => {});

    await untilExec(client);
    channel.emit("data", Buffer.from("hi\n"));
    channel.emit("exit", 0);
    channel.emit("close", 0);

    await expect(p).resolves.toEqual({ code: 0, output: "hi\n" });
  });
});

describe("exec timeout", () => {
  it("closes the remote channel before rejecting", async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    const client = fakeClient((_cmd, cb) => cb(null, channel));
    connectSshClient.mockResolvedValue(client);
    const executor = new SshExecutor(CONFIG);
    const pending = executor.exec("sleep 999", { timeout: 100 });

    for (let i = 0; i < 8 && client.exec.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(client.exec).toHaveBeenCalledTimes(1);
    const rejection = expect(pending).rejects.toThrow("Command timed out after 100ms");
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(channel.close).toHaveBeenCalledTimes(1);
  });
});

describe("channel retry", () => {
  it("recovers and retries when client.exec fails with 'Unable to exec'", async () => {
    const channel = new FakeChannel();
    let attempts = 0;
    const client1 = fakeClient((_cmd, cb) => {
      attempts += 1;
      cb(new Error("Unable to exec"), null as unknown as FakeChannel);
    });
    const client2 = fakeClient((_cmd, cb) => {
      attempts += 1;
      cb(null, channel);
    });

    connectSshClient
      .mockResolvedValueOnce(client1)
      .mockResolvedValueOnce(client2);

    const executor = new SshExecutor(CONFIG);
    const p = executor.exec("git --version");

    await untilExec(client2);
    channel.emit("data", Buffer.from("git version 2.55.0\n"));
    channel.emit("exit", 0);
    channel.emit("close", 0);

    await expect(p).resolves.toBe("git version 2.55.0");
    expect(attempts).toBe(2);
    expect(client1.end).toHaveBeenCalled();
  });

  it("does not retry an executed command whose stderr equals the ssh2 sentinel", async () => {
    const channel = new FakeChannel();
    const client = fakeClient((_cmd, cb) => cb(null, channel));
    connectSshClient.mockResolvedValue(client);

    const executor = new SshExecutor(CONFIG);
    const pending = executor.exec("run-mutating-command");

    await untilExec(client);
    channel.stderr.emit("data", Buffer.from("Unable to exec\n"));
    channel.emit("exit", 1);
    channel.emit("close", 1);

    await expect(pending).rejects.toThrow("Unable to exec");
    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(connectSshClient).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("retries a rejected request without interrupting another in-flight command", async () => {
    const liveChannel = new FakeChannel();
    const retryChannel = new FakeChannel();
    const client = fakeClient((_cmd, cb) => {
      const attempt = client.exec.mock.calls.length;
      if (attempt === 1) cb(null, liveChannel);
      else if (attempt === 2) cb(new Error("Unable to exec"), null as unknown as FakeChannel);
      else cb(null, retryChannel);
    });
    connectSshClient.mockResolvedValue(client);

    const executor = new SshExecutor(CONFIG);
    const live = executor.exec("long-running-command");
    await untilExecCount(client, 1);

    const retried = executor.exec("git --version");
    await untilExecCount(client, 3);
    retryChannel.emit("data", Buffer.from("git version 2.55.0\n"));
    retryChannel.emit("exit", 0);
    retryChannel.emit("close", 0);

    await expect(retried).resolves.toBe("git version 2.55.0");
    expect(connectSshClient).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();

    liveChannel.emit("data", Buffer.from("done\n"));
    liveChannel.emit("exit", 0);
    liveChannel.emit("close", 0);
    await expect(live).resolves.toBe("done");
  });

  it("retries streamExec when ssh2 rejects the exec request", async () => {
    const channel = new FakeChannel();
    const client1 = fakeClient((_cmd, cb) =>
      cb(new Error("Unable to exec"), null as unknown as FakeChannel),
    );
    const client2 = fakeClient((_cmd, cb) => cb(null, channel));
    connectSshClient.mockResolvedValueOnce(client1).mockResolvedValueOnce(client2);

    const executor = new SshExecutor(CONFIG);
    const logs: string[] = [];
    const pending = executor.streamExec("echo ready", (entry) => logs.push(entry.message));

    await untilExec(client2);
    channel.emit("data", Buffer.from("ready\n"));
    channel.emit("exit", 0);
    channel.emit("close", 0);

    await expect(pending).resolves.toEqual({ code: 0, output: "ready\n" });
    expect(logs).toEqual(["ready\n"]);
    expect(client1.end).toHaveBeenCalled();
    expect(client1.exec).toHaveBeenCalledTimes(1);
    expect(client2.exec).toHaveBeenCalledTimes(1);
  });
});
