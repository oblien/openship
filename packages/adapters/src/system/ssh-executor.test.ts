import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  return {
    on: vi.fn(),
    exec: vi.fn(onExec),
  };
}

const CONFIG = { host: "h", username: "u", privateKey: "k" };

/** connect() is async, so exec (and the listener wiring inside it) runs a few microtasks
 *  after streamExec is called. Emitting channel events before that would hit no listeners.
 *  waitFor retries until the exec callback has fired. */
const untilExec = (client: ReturnType<typeof fakeClient>) =>
  vi.waitFor(() => {
    if (!client.exec.mock.calls.length) throw new Error("exec not called yet");
  });

beforeEach(() => {
  connectSshClient.mockReset();
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
