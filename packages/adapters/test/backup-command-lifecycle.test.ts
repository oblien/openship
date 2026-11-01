import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCommandOutput } from "../src/backup/common/command-stream";
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
      const capture = await executor.streamPath({ ...service, volumes: [join(bin, "missing-source")] }, join(bin, "missing-source"), {
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
      await executor.receiveStream({ ...service, volumes: ["/var/data"] }, "/var/data", Readable.from([bytes]), {
        compression: "none",
      }),
    ).toEqual({ bytesWritten: bytes.length });
    expect(received).toEqual(bytes);
  });
});
