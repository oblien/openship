/**
 * `pipeIntoCommand` is how every LOGICAL restore applies — pg_restore, mysql,
 * mongorestore, redis, custom_command — and it was the one direction with no
 * completion backstop. Its old ceiling closed stdin and then kept waiting, which a
 * loader blocked on a lock ignores: nothing settled, the restore row sat in `applying`
 * until a stale sweep guessed at it, and the exec was never reaped.
 *
 * These cases pin the three outcomes that replaced that, and the ONE thing a naive
 * version gets wrong: the exit poll must stay shut until the body is fully written,
 * because an exec that has not been handed all of its input yet is expected to still
 * be running.
 *
 * The hijacked socket and the demuxer are mocked — this is about which promise
 * settles, and the framing has its own tests.
 */

import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ socket: null as unknown as PassThrough }));

vi.mock("../../runtime/docker-exec-stream", () => ({
  daemonConnectionFrom: () => ({}),
  startExecStream: async () => h.socket,
  startAttachStream: async () => {
    throw new Error("startAttachStream is not part of pipeIntoCommand");
  },
}));

vi.mock("../../runtime/docker-demux", () => ({
  demuxDockerStream: () => {},
}));

import { DockerBackupExecutor } from "./docker";
import type { ServiceHandle } from "../types";

type Inspection = { Running?: boolean; ExitCode?: number | null };

let inspections = 0;
let inspect: () => Promise<Inspection>;

function makeExecutor(): DockerBackupExecutor {
  return new DockerBackupExecutor({
    docker: {
      getContainer: () => ({
        exec: async () => ({
          id: "exec_1",
          inspect: async () => {
            inspections += 1;
            return inspect();
          },
        }),
      }),
    },
  } as never);
}

const service = {
  id: "svc_1",
  projectId: "prj_1",
  projectSlug: "clincai",
  name: "db",
  image: "postgres:16",
  env: {},
  volumes: [],
  containerId: "ctr_1",
} as unknown as ServiceHandle;

beforeEach(() => {
  h.socket = new PassThrough();
  inspections = 0;
  inspect = async () => ({ Running: false, ExitCode: 0 });
});

describe("DockerBackupExecutor.pipeIntoCommand completion", () => {
  it("resolves from the attach stream's own end", async () => {
    // Draining the socket is what lets its readable side emit `end` once
    // `body.pipe` half-closes it — the healthy shape.
    h.socket.resume();
    inspect = async () => ({ Running: false, ExitCode: 0 });

    const started = Date.now();
    const exit = await makeExecutor().pipeIntoCommand(
      service,
      ["sh", "-c", "pg_restore"],
      Readable.from([Buffer.from("dump")]),
    );

    expect(exit.code).toBe(0);
    // Well under the 2s poll interval: this came from the stream, not the poll.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("resolves from the exec status poll when the socket never EOFs", async () => {
    // Nothing drains the socket, so no `end` ever arrives — the #516 shape, one
    // direction over. Without the poll this call never settles.
    inspect = async () => ({ Running: false, ExitCode: 3 });

    const exit = await makeExecutor().pipeIntoCommand(
      service,
      ["sh", "-c", "mysql"],
      Readable.from([Buffer.from("dump")]),
      { timeoutMs: 20_000 },
    );

    expect(exit.code).toBe(3);
    expect(inspections).toBeGreaterThan(0);
  });

  it("does NOT poll before the body is fully written", async () => {
    // A stalled artifact stream with an exec the daemon already calls finished. Reading
    // that as a clean exit would report a restore as applied while most of the payload
    // was never handed over, so the poll stays shut and the ceiling is what settles it.
    const body = new PassThrough();
    body.write(Buffer.from("partial"));
    inspect = async () => ({ Running: false, ExitCode: 0 });

    await expect(
      makeExecutor().pipeIntoCommand(service, ["sh", "-c", "pg_restore"], body, {
        timeoutMs: 2_500,
      }),
    ).rejects.toThrow(/may hold partial data/);
  });

  it("rejects at the ceiling, and drops the socket so the write stops", async () => {
    const body = Readable.from([Buffer.from("dump")]);
    inspect = async () => ({ Running: true });

    await expect(
      makeExecutor().pipeIntoCommand(service, ["sh", "-c", "pg_restore"], body, {
        timeoutMs: 1_200,
      }),
    ).rejects.toThrow(/exceeded its 1s ceiling and was abandoned\. The target may hold partial data/);

    // Leaving these open kept a wedged loader fed while the row already said failed.
    expect(h.socket.destroyed).toBe(true);
    expect(body.destroyed).toBe(true);
  });
});
