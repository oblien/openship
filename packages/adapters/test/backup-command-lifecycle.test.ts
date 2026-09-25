import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCommandOutput } from "../src/backup/common/command-stream";
import { CloudBackupExecutor } from "../src/backup/executors/cloud";
import type { CloudRuntime } from "../src/runtime/cloud";
import type { ServiceHandle } from "../src/backup/types";
import { BareBackupExecutor } from "../src/backup/executors/bare";
import type { BareRuntime } from "../src/runtime/bare";
import { spawn } from "node:child_process";
import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.useRealTimers());

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("command capture lifecycle", () => {
  it("preserves early binary output until an upload attaches and preserves process status", async () => {
    const child = {
      stdout: Readable.from([Buffer.from([0, 255, 13, 10])]),
      stderr: Readable.from([Buffer.from("diagnostic")]),
      onClose: Promise.resolve(7),
      kill: vi.fn(),
    };
    const capture = captureCommandOutput(child);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await collect(capture.stdout)).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(await capture.awaitExit).toEqual({ code: 7, stderr: "diagnostic" });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("cancels a blocked source immediately when storage stops reading", async () => {
    const child = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onClose: new Promise<number>(() => {}),
      kill: vi.fn(),
    };
    const capture = captureCommandOutput(child);
    const failure = expect(capture.awaitExit).rejects.toThrow(/closed before capture completed/);
    child.stdout.write(Buffer.alloc(4 * 1024 * 1024));
    capture.stdout.destroy();
    await failure;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it("bounds a silent source without making a live slow transfer a failure", async () => {
    vi.useFakeTimers();
    let exit!: (code: number) => void;
    const child = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onClose: new Promise<number>((resolve) => {
        exit = resolve;
      }),
      kill: vi.fn(),
    };
    const capture = captureCommandOutput(child, { idleTimeoutMs: 1_000, timeoutMs: 10_000 });
    const body = collect(capture.stdout);
    for (let i = 0; i < 5; i++) {
      child.stdout.write("x");
      await vi.advanceTimersByTimeAsync(500);
    }
    child.stdout.end();
    child.stderr.end();
    exit(0);
    expect((await body).toString()).toBe("xxxxx");
    expect((await capture.awaitExit).code).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();

    const stalled = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onClose: new Promise<number>(() => {}),
      kill: vi.fn(),
    };
    const idle = captureCommandOutput(stalled, { idleTimeoutMs: 1_000 });
    const failure = expect(idle.awaitExit).rejects.toThrow(/no data/);
    await vi.advanceTimersByTimeAsync(1_001);
    await failure;
    expect(stalled.kill).toHaveBeenCalledOnce();
  });
});

const service: ServiceHandle = {
  id: "service",
  projectId: "project",
  name: "db",
  image: "postgres:17",
  env: {},
  volumes: [],
  containerId: "workspace",
  projectSlug: "project",
  namespaceVolumes: false,
};

function cloud(stream: ReturnType<typeof vi.fn>, kill = vi.fn().mockResolvedValue(undefined)) {
  const executor = new CloudBackupExecutor({
    client: { workspace: () => ({ runtime: async () => ({ exec: { stream, kill } }) }) },
  } as unknown as CloudRuntime);
  return { executor, kill };
}

describe("cloud backups use the workspace's shared binary transport", () => {
  it("forwards the path capture time budget and idle watchdog", async () => {
    const { executor, kill } = cloud(
      vi.fn(async function* () {
        yield { event: "task_id", task_id: "silent-capture" };
        await new Promise(() => {});
      }),
    );
    const capture = await executor.streamPath(service, "/app", {
      idleTimeoutMs: 30,
      timeoutMs: 1_000,
    });
    await expect(capture.awaitExit).rejects.toThrow("no data");
    expect(kill).toHaveBeenCalledExactlyOnceWith("silent-capture");
  });
  it("preserves bytes, checks the command exit, and uses the backup time budget", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 7]);
    const stream = vi.fn(async function* (command: string[]) {
      yield { event: "task_id", task_id: "backup-task" };
      yield { event: "stdout", data: bytes.toString("base64") };
      const marker = command.at(-1)!.match(/openship-exit-[a-f0-9-]+:/)![0];
      yield { event: "stdout", data: Buffer.from(`\x1e${marker}0\x1f`).toString("base64") };
      yield { event: "exit", exit_code: 1 };
      throw new Error("must finish at the command exit");
    });
    const { executor, kill } = cloud(stream);
    const capture = await executor.execStream(service, ["pg_dump", "-Fc"]);
    expect(await collect(capture.stdout)).toEqual(bytes);
    expect((await capture.awaitExit).code).toBe(0);
    expect(stream).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        execMode: "direct",
        keepLogs: false,
        timeoutSeconds: 21_600,
      }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("rejects an unverified success instead of keeping a truncated dump", async () => {
    const { executor } = cloud(
      vi.fn(async function* () {
        yield { event: "exit", exit_code: 0 };
      }),
    );
    const capture = await executor.execStream(service, ["pg_dump"]);
    const read = collect(capture.stdout).catch(() => {});
    await expect(capture.awaitExit).rejects.toThrow(/verified exit status/);
    await read;
  });

  it("kills only its own task and closes a blocked event pump when upload fails", async () => {
    let closed = false;
    let emitted = 0;
    const stream = vi.fn(async function* () {
      try {
        yield { event: "task_id", task_id: "backup-task" };
        while (true) {
          emitted++;
          yield { event: "stdout", data: Buffer.alloc(1024 * 1024).toString("base64") };
        }
      } finally {
        closed = true;
      }
    });
    const { executor, kill } = cloud(stream);
    const capture = await executor.execStream(service, ["pg_dump"]);
    await expect.poll(() => emitted).toBeGreaterThan(1);
    capture.stdout.destroy();
    await expect(capture.awaitExit).rejects.toThrow(/closed before capture completed/);
    await expect.poll(() => closed).toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith("backup-task");
    expect(emitted).toBeLessThan(10);
  });
});

describe("bare capture and restore keep the source bytes and status", () => {
  it("reports a real tar failure even when the compressor succeeds", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openship-backup-pipeline-"));
    try {
      await symlink("/usr/bin/tar", join(bin, "tar"));
      await symlink("/bin/sh", join(bin, "sh"));
      await writeFile(join(bin, "zstd"), "#!/bin/sh\n/bin/cat\n", { mode: 0o700 });
      const executor = new BareBackupExecutor({
        commandExecutor: {
          rawExec: async (command: string) => {
            const child = spawn("/bin/sh", ["-c", command], { env: { PATH: bin } });
            return {
              stdout: child.stdout,
              stderr: child.stderr,
              onClose: new Promise<number>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code) => resolve(code ?? 1));
              }),
              kill: () => {
                child.kill();
              },
            };
          },
        },
      } as unknown as BareRuntime);
      const capture = await executor.streamPath(service, join(bin, "missing-source"), {
        compression: "zstd",
      });
      await collect(capture.stdout);
      const result = await capture.awaitExit;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("dump command");
      await expect(executor.streamPath(service, "/data", { quiesce: true })).rejects.toThrow(
        "cannot freeze",
      );
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("retains early input while the restore transport is still opening", async () => {
    const bytes = Buffer.alloc(1024 * 1024, 171);
    let received: Buffer | undefined;
    const executor = new BareBackupExecutor({
      commandExecutor: {
        rawExec: () => {
          throw new Error("not used");
        },
        execWithInput: async (_cmd: string, body: Readable) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          received = await collect(body);
          return { code: 0, stderr: "", stdout: "" };
        },
      },
    } as unknown as BareRuntime);
    expect(
      await executor.receiveStream(service, "/var/data", Readable.from([bytes]), {
        compression: "none",
      }),
    ).toEqual({ bytesWritten: bytes.length });
    expect(received).toEqual(bytes);
  });
});
