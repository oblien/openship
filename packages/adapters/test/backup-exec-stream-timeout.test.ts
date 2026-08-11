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

import type { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceHandle } from "../src/backup/types";
import { DockerRuntime } from "../src/runtime/docker";
import { DockerBackupExecutor } from "../src/backup/executors/docker";
import { drive, FakeAttachStream } from "./helpers/docker-helper-harness";

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
  const execInspectable = {
    id: "exec_1",
    start: vi.fn(async () => stream),
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
      runtime.docker.modem = {
        demuxStream: (src: FakeAttachStream, out: Writable, err: Writable) => {
          src.on("data", (chunk: Buffer) => out.write(chunk));
          src.on("data", (chunk: Buffer) => err.write(chunk));
        },
      } as never;
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
