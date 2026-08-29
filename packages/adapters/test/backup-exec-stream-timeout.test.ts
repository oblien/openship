/**
 * The database-dump direction of #516.
 *
 * `streamPath` and `receiveStream` got idle watchdogs in #434; `execStream`
 * (pg_dump, mysqldump, hooks) kept a wall-clock timer only when the caller
 * passed `timeoutMs`, and no idle bound at all — so a wedged `pg_dump | zstd`
 * pipe hung forever with `bytesTransferred` still null. These tests pin the
 * same four properties the capture suite does: silence bounded, traffic not,
 * ceiling enforced, and stdout destroyed on failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceHandle } from "../src/backup/types";
import { DockerRuntime } from "../src/runtime/docker";
import { DockerBackupExecutor } from "../src/backup/executors/docker";
import { drive, FakeAttachStream } from "./helpers/docker-helper-harness";

/** Set by execHarness; a vi.mock factory is hoisted so it cannot close over a `let`. */
const execStreamControl = vi.hoisted(() => ({ stream: null as unknown, calls: 0 }));

vi.mock("../src/runtime/docker-exec-stream", () => ({
  daemonConnectionFrom: () => ({ socketPath: "/var/run/docker.sock" }),
  startExecStream: async () => {
    execStreamControl.calls += 1;
    return execStreamControl.stream;
  },
  startAttachStream: async () => execStreamControl.stream,
}));

const SERVICE: ServiceHandle = {
  id: "svc_1",
  projectId: "prj_1",
  name: "db",
  image: "postgres:16",
  env: { POSTGRES_DB: "app" },
  volumes: [],
  containerId: "ctr_pg",
  projectSlug: "shop",
  namespaceVolumes: false,
};

function execHarness(stream: FakeAttachStream) {
  execStreamControl.stream = stream;
  execStreamControl.calls = 0;
  const execInspectable = {
    id: "exec_1",
    // No `start` any more — the executor never calls dockerode's exec start; the
    // module mock above hands back the socket. `inspect` stays: that is how
    // resolveExecExitCode reads the exit status.
    inspect: vi.fn(async () => ({ Running: false, ExitCode: 0 })),
  };
  const container = {
    exec: vi.fn(async () => execInspectable),
  };

  return {
    execInspectable,
    async executor() {
      const runtime = await DockerRuntime.create();
      (runtime as unknown as { pullImage: () => Promise<void> }).pullImage = async () => {};
      runtime.docker.getContainer = (() => container) as never;
      runtime.docker.getExec = (() => execInspectable) as never;
      // Two stand-ins are gone. No `modem.demuxStream` fake — attachDemuxed runs the
      // real frame demuxer now, so the fake stream emits real frames and the routing
      // to stdout vs stderr is the code under test rather than the fake's own guess
      // (the old one wrote every chunk to BOTH sinks). And no `exec.start` fake:
      // execStream opens the RAW socket via `startExecStream`, because dockerode's
      // non-hijack start yields an `http.IncomingMessage` that Bun will not stop
      // reading, which would make the demuxer's backpressure a no-op on the exact
      // path #633 reported. The module is mocked below.
      runtime.docker.modem = {} as never;
      return new DockerBackupExecutor(runtime);
    },
  };
}

function collect(stdout: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c));
  stdout.on("error", () => {});
  return () => Buffer.concat(chunks).toString("utf8");
}

let stream: FakeAttachStream;

beforeEach(() => {
  vi.useFakeTimers();
  stream = new FakeAttachStream();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("execStream silence is bounded, traffic is not", () => {
  it("abandons an exec that produces nothing for the idle window", async () => {
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 5_000,
      timeoutMs: 60_000,
    });
    collect(stdout);

    await expect(drive(awaitExit, 30_000)).rejects.toThrow(/produced no data for 5s/);
  });

  it("uses the same 10-minute idle default as capture when the caller sets none", async () => {
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"]);
    collect(stdout);

    await expect(drive(awaitExit, 11 * 60_000, 5_000)).rejects.toThrow(/no data for 600s/);
  });

  it("lets a slow but live exec run far past the idle window", async () => {
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 5_000,
      timeoutMs: 120_000,
    });
    const read = collect(stdout);
    awaitExit.catch(() => {});

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      stream.emitOutput("dump.");
    }
    stream.finish();

    await expect(drive(awaitExit, 30_000)).resolves.toMatchObject({ code: 0 });
    expect(read()).toBe("dump.".repeat(5));
  });

  it("enforces an absolute ceiling even while bytes keep flowing", async () => {
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 60_000,
      timeoutMs: 10_000,
    });
    collect(stdout);
    awaitExit.catch(() => {});

    for (let i = 0; i < 20; i++) {
      stream.emitOutput("trickle");
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(drive(awaitExit, 30_000)).rejects.toThrow(/exceeded its 10s ceiling/);
  });
});

describe("execStream stdout reaches EOF (not just awaitExit)", () => {
  it("ends stdout when the attach stream finishes, so a piped consumer isn't left waiting forever", async () => {
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
    });
    const read = collect(stdout);
    awaitExit.catch(() => {});

    const stdoutEnded = new Promise<void>((resolve) => stdout.on("end", resolve));

    stream.emitOutput("dump-bytes");
    stream.finish();

    // docker-modem's demuxStream only forwards 'data' — it never closes the
    // destination streams itself. A consumer piping stdout downstream (the
    // SFTP/S3 destination writer) waits on this 'end' event to know the
    // artifact is complete. Before the fix, this never fires and the
    // downstream write stream hangs forever despite every byte already
    // having arrived.
    await drive(stdoutEnded, 5_000);
    expect(read()).toBe("dump-bytes");
  });
});

describe("the capture transport is the raw socket, not modem's http response", () => {
  it("reads the dump through startExecStream and never through dockerode's exec.start", async () => {
    // This pins a choice that is invisible at runtime until it costs you the whole
    // #633 fix. dockerode's non-hijack `exec.start()` resolves to the
    // `http.IncomingMessage`, and pausing one of those does not stop the daemon under
    // Bun — measured on Bun 1.3.1: a peer streaming 64 KB chunks pushed the entire
    // 2 GB while the paused consumer had seen 0.1 MB, where Node blocked it at
    // ~0.9 MB. On a raw net.Socket Bun stops at ~1.6 MB, like Node.
    //
    // So `demuxDockerStream` can only apply real backpressure to a socket we own. A
    // future "simplification" back to `exec.start()` would keep every other test green
    // and quietly restore the OOM on the exact path the issue reported, which is why
    // the transport is asserted rather than assumed.
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
    });
    collect(stdout);
    awaitExit.catch(() => {});
    stream.emitOutput("bytes");
    stream.finish();
    await drive(awaitExit, 5_000);

    // The only assertion that says anything about production code: the raw-socket
    // helper was the thing that produced the stream. (An earlier version also asserted
    // the fake had no `start` method, which only tested the fixture this file writes.)
    expect(execStreamControl.calls).toBe(1);
  });
});

describe("a demux failure beats the exec's own exit status", () => {
  it("rejects awaitExit on a desync instead of reporting the exec's 0", async () => {
    // The subtle half of owning the demuxer. `attachDemuxed` learns the exit code from
    // the attach stream's `end`, and that still fires after a desynchronized frame
    // boundary — so without a separate error channel the run would read the exec's
    // clean `0` and record a TRUNCATED dump as a complete backup. Which is the failure
    // this whole pass exists to remove, arriving through the fix for it.
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
    });
    collect(stdout);

    stream.emitOutput("good-bytes");
    // Frame type 9 is not stdin/stdout/stderr: alignment is lost, and the bytes read
    // so far cannot be trusted as a whole artifact.
    stream.push(Buffer.from([9, 0, 0, 0, 0, 0, 0, 1, 0x41]));
    stream.finish();

    await expect(drive(awaitExit, 10_000)).rejects.toThrow(/desynchronized/);
    // The exec itself would have reported success — that is the point.
    await expect(h.execInspectable.inspect()).resolves.toMatchObject({ ExitCode: 0 });
  });

  it("rejects awaitExit when the stream ends mid-frame", async () => {
    // A cut connection leaves an incomplete frame buffered. The daemon only ever writes
    // whole frames, so this is a definitive truncation — and it must not look like a
    // clean EOF, because we hash and record whatever arrived, so a short artifact would
    // pass its own integrity check at restore time and read as a smaller database.
    const h = execHarness(stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.execStream(SERVICE, ["pg_dump"], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
    });
    collect(stdout);

    const whole = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 10]), Buffer.from("0123456789")]);
    stream.push(whole.subarray(0, 12)); // header + 4 of 10 payload bytes
    stream.finish();

    await expect(drive(awaitExit, 10_000)).rejects.toThrow(/ended mid-frame/);
  });
});

describe("a broken restore rejects instead of killing the process", () => {
  it("survives an attach error while the payload is still being written", async () => {
    // The crash `demuxDockerStream` introduced on the RESTORE side. modem's demuxer
    // only ever wrote to its sinks; ours destroys `stdout` with an Error on any abnormal
    // end. `pipeIntoCommand`'s stdout sink is internal and discarded, so no downstream
    // consumer can supply the `'error'` listener — and there is no `uncaughtException`
    // handler in this process, so the API would die mid-restore, taking every other
    // in-flight backup, restore and deployment with it and stranding the restore row.
    //
    // Reachable on all five restore paths: when the loader exits early (wrong
    // credentials under ON_ERROR_STOP=1) the daemon closes the socket while the archive
    // is still being written, the next write yields EPIPE, and the bridge duplex emits
    // `'error'`. Without the listener this test aborts the whole run with an unhandled
    // error rather than failing an assertion.
    const h = execHarness(stream);
    const exec = await h.executor();
    const { Readable } = await import("node:stream");

    const pumping = exec.pipeIntoCommand(
      SERVICE,
      ["sh", "-c", "pg_restore -d app"],
      Readable.from([Buffer.from("archive-bytes")]),
      { timeoutMs: 60_000 },
    );

    // Let pipeIntoCommand finish its async setup (dynamic import, container.exec, the
    // socket upgrade) before the socket dies — otherwise `emit("error")` lands before
    // any listener exists and throws synchronously in the test rather than exercising
    // the path.
    await vi.advanceTimersByTimeAsync(10);
    stream.emit("error", new Error("write EPIPE"));

    await expect(drive(pumping, 5_000)).rejects.toThrow(/EPIPE/);
  });
});
