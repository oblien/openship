import { PassThrough } from "node:stream";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import Dockerode from "dockerode";
import { DockerRuntime } from "./docker";

async function runtimeWith(stream: PassThrough, tty = false): Promise<DockerRuntime> {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-runtime-logs-test.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = {
    getContainer: () => ({
      inspect: vi.fn(async () => ({ Config: { Tty: tty } })),
      logs: vi.fn(async () => stream),
    }),
  };
  return runtime;
}

describe("DockerRuntime.streamRuntimeLogs", () => {
  it("reports a natural stream end once", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", vi.fn(), { onEnd });

    const ended = once(stream, "end");
    stream.end();
    await ended;
    stream.emit("close");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });

  it("does not report an explicit cleanup as a natural end", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    const cleanup = await (await runtimeWith(stream)).streamRuntimeLogs(
      "container-1",
      vi.fn(),
      { onEnd },
    );

    cleanup();
    stream.emit("end");
    stream.emit("close");

    expect(onEnd).not.toHaveBeenCalled();
  });

  it("preserves a source error when the stream terminates", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", vi.fn(), { onEnd });

    stream.emit("error", new Error("socket closed"));
    stream.emit("close");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ message: "socket closed" }));
  });
});

/** One Docker multiplexed frame: `[streamType, 0, 0, 0, uint32be size]` + payload. */
function frame(text: string | Buffer, streamType = 1): Buffer {
  const payload = typeof text === "string" ? Buffer.from(text, "utf-8") : text;
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function messagesFrom(chunks: Buffer[], tty = false): Promise<string[]> {
  const stream = new PassThrough();
  const onLog = vi.fn();
  await (await runtimeWith(stream, tty)).streamRuntimeLogs("container-1", onLog);
  const ended = once(stream, "end");
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  stream.resume();
  await ended;
  return onLog.mock.calls.map(([entry]) => `${entry.timestamp} ${entry.message}`);
}

describe("DockerRuntime.streamRuntimeLogs frame parsing", () => {
  const first = "2026-10-25T10:00:00.000000000Z GET / 200\n";
  const second = "2026-10-25T10:00:01.000000000Z worker started\n";
  const lines = [
    "2026-10-25T10:00:00.000000000Z GET / 200",
    "2026-10-25T10:00:01.000000000Z worker started",
  ];

  it("strips every frame header when several frames share one chunk", async () => {
    await expect(messagesFrom([Buffer.concat([frame(first), frame(second, 2)])])).resolves.toEqual(
      lines,
    );
  });

  it("reassembles frames whose header or payload straddles chunks", async () => {
    const bytes = Buffer.concat([frame(first), frame(second, 2)]);
    const cuts = [3, 20, bytes.length - 50, bytes.length - 5];
    const chunks = [0, ...cuts].map((start, i) => bytes.subarray(start, cuts[i] ?? bytes.length));
    await expect(messagesFrom(chunks)).resolves.toEqual(lines);
  });

  it("keeps a multi-byte character that is split across chunks", async () => {
    const bytes = frame("2026-10-25T10:00:00.000000000Z café ✓\n");
    const cut = bytes.indexOf(Buffer.from("✓")) + 1;
    await expect(messagesFrom([bytes.subarray(0, cut), bytes.subarray(cut)])).resolves.toEqual([
      "2026-10-25T10:00:00.000000000Z café ✓",
    ]);
  });

  it("passes TTY output, which has no frame headers, through unchanged", async () => {
    await expect(messagesFrom([Buffer.from(first + second)], true)).resolves.toEqual(lines);
  });
});


describe("Docker log stream boundaries", () => {
  it("keeps UTF-8 and partial lines separate for stdout and stderr", async () => {
    const stdout = Buffer.from("2026-10-25T10:00:00.000000000Z price €\n");
    const cut = stdout.indexOf(Buffer.from("€")) + 1;
    await expect(messagesFrom([
      frame(stdout.subarray(0, cut)),
      frame("2026-10-25T10:00:01.000000000Z warning\n", 2),
      frame(stdout.subarray(cut)),
    ])).resolves.toEqual([
      "2026-10-25T10:00:01.000000000Z warning",
      "2026-10-25T10:00:00.000000000Z price €",
    ]);
  });

  it("flushes unterminated lines with their original timestamps on each stream", async () => {
    await expect(messagesFrom([
      frame("2026-10-25T10:00:00.000000000Z stdout tail"),
      frame("2026-10-25T10:00:01.000000000Z stderr tail", 2),
    ])).resolves.toEqual([
      "2026-10-25T10:00:00.000000000Z stdout tail",
      "2026-10-25T10:00:01.000000000Z stderr tail",
    ]);
  });

  it.each(["oversized", "truncated", "invalid type"])("reports %s frames once and closes the source", async (kind) => {
    const stream = new PassThrough();
    const onLog = vi.fn();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", onLog, { onEnd });
    const bytes = frame("incomplete");
    if (kind === "oversized") bytes.writeUInt32BE(0xffffffff, 4);
    if (kind === "invalid type") bytes[0] = 7;
    stream.end(bytes.subarray(0, 10));
    await new Promise((resolve) => setImmediate(resolve));
    stream.emit("close");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(expect.any(Error));
    expect(onLog).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it("does not emit buffered output or errors after explicit cleanup", async () => {
    const stream = new PassThrough();
    const onLog = vi.fn();
    const onEnd = vi.fn();
    const cleanup = await (await runtimeWith(stream)).streamRuntimeLogs("container-1", onLog, { onEnd });
    stream.write(frame("2026-10-25T10:00:00.000000000Z tail"));
    cleanup();
    stream.emit("data", frame("ignored\n"));
    stream.emit("end");
    await new Promise((resolve) => setImmediate(resolve));
    expect(onLog).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});


describe.runIf(process.env.RUN_DOCKER_E2E === "1")("real Docker live logs", () => {
  it.each([false, true])("follows a container with Tty=%s through natural completion", async (tty) => {
    const socketPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, "") ?? "/var/run/docker.sock";
    const docker = new Dockerode({ socketPath });
    await docker.ping();
    const runtime = await DockerRuntime.create({ dockerSocketPath: socketPath });
    const container = await docker.createContainer({
      Image: "busybox:1.37-musl",
      Cmd: ["sh", "-c", "sleep 1; printf 'price €\\n'; printf 'warning ✓\\n' >&2"],
      Tty: tty,
      Labels: { "openship.test": "pr1482-live-logs" },
    });
    let cleanup: (() => void) | undefined;
    try {
      await container.start();
      const messages: string[] = [];
      let finish!: (error?: Error) => void;
      const ended = new Promise<void>((resolve, reject) => {
        finish = (error) => error ? reject(error) : resolve();
      });
      cleanup = await runtime.streamRuntimeLogs(container.id, (entry) => {
        expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        messages.push(entry.message.trimEnd());
      }, { tail: 100, onEnd: finish });
      await ended;
      expect(messages).toEqual(["price €", "warning ✓"]);
    } finally {
      cleanup?.();
      await container.remove({ force: true });
      await runtime.dispose();
    }
  });
});
