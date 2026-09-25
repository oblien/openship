import { createWriteStream, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { shellQuote, withTimeout } from "@repo/core";
import type { ExecuteCommandOpts, ExecExitInfo, ReceiveStreamOpts } from "../types";
import { safeRestoreCommand } from "./dump-pipeline";

const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 30_000;

/** A single shell boundary: env/cwd apply to the whole command, including scripts. */
export function backupShellCommand(cmd: string[], opts?: ExecuteCommandOpts): string {
  const env = Object.entries(opts?.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    return `${key}=${shellQuote(value)}`;
  });
  return [
    opts?.cwd ? `cd ${shellQuote(opts.cwd)} &&` : "",
    env.length ? `env ${env.join(" ")}` : "",
    cmd.map(shellQuote).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

interface RestoreTransport {
  run(command: string, opts: ExecuteCommandOpts): Promise<ExecExitInfo>;
  /** SSH can stream directly. Other transports stage one file before executing. */
  input?(command: string, body: Readable, signal: AbortSignal): Promise<ExecExitInfo>;
  stage(localDir: string, remoteDir: string, signal: AbortSignal): Promise<void>;
}

/** Shared restore budget, private staging and cleanup for SSH and native workspaces. */
export async function pipeRestoreCommand(
  transport: RestoreTransport,
  serviceName: string,
  cmd: string[],
  body: Readable,
  opts?: ExecuteCommandOpts,
): Promise<ExecExitInfo> {
  const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : RESTORE_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = () => controller.abort(opts?.signal?.reason);
  opts?.signal?.addEventListener("abort", abort, { once: true });
  if (opts?.signal?.aborted) abort();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Restore into ${serviceName} exceeded its ${Math.round(timeoutMs / 1000)}s ceiling ` +
            "and was abandoned. The target may hold partial data.",
        ),
      ),
    timeoutMs,
  );
  timer.unref?.();
  let rejectAbort!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Install before starting any async setup; a source may fail while mkdir awaits.
  const sourceError = (error: Error) => controller.abort(error);
  body.on("error", sourceError);
  const onAbort = () => {
    const error =
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Restore cancelled");
    body.destroy(error);
    rejectAbort(error);
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();

  let localDir: string | undefined;
  let remoteDir: string | undefined;
  const run = async (command: string) => {
    controller.signal.throwIfAborted();
    const result = await transport.run(command, {
      timeoutMs: remaining(),
      idleTimeoutMs: opts?.idleTimeoutMs,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    return result;
  };
  const work = (async () => {
    controller.signal.throwIfAborted();
    const command = backupShellCommand(cmd, opts);
    if (transport.input) return transport.input(command, body, controller.signal);

    localDir = await fs.mkdtemp(join(tmpdir(), "openship-restore-"));
    controller.signal.throwIfAborted();
    const localFile = join(localDir, "artifact.bin");
    await pipeline(body, createWriteStream(localFile, { mode: 0o600 }), {
      signal: controller.signal,
    });
    const size = (await fs.stat(localFile)).size;
    remoteDir = `/tmp/openship-restore-${randomUUID()}`;
    const setup = await run(`umask 077; mkdir -m 700 ${shellQuote(remoteDir)}`);
    if (setup.code !== 0) throw new Error(`Could not stage restore: ${setup.stderr}`);
    await transport.stage(localDir, remoteDir, controller.signal);
    controller.signal.throwIfAborted();
    const remoteFile = shellQuote(`${remoteDir}/artifact.bin`);
    // The SDK upload endpoint extracts an archive into a directory. Prove that
    // its extracted file is complete before any loader can mutate the target.
    return run(
      `[ -f ${remoteFile} ] && [ "$(wc -c < ${remoteFile})" -eq ${size} ] || ` +
        `{ echo 'Restore staging was incomplete; the target was not changed.' >&2; exit 91; };\n` +
        `${command} < ${remoteFile}`,
    );
  })();

  const cleanup = async () => {
    if (remoteDir) {
      // This has its own budget and no cancelled signal: cleanup still runs
      // after a failed upload, setup or loader, not just inside the loader shell.
      const result = await withTimeout(
        transport.run(`rm -rf -- ${shellQuote(remoteDir)}`, { timeoutMs: CLEANUP_TIMEOUT_MS }),
        CLEANUP_TIMEOUT_MS,
        "Could not clean restore staging on the target",
      );
      if (result.code !== 0) throw new Error(`Could not clean restore staging: ${result.stderr}`);
    }
  };
  let failed = false;
  try {
    return await Promise.race([work, cancelled]);
  } catch (error) {
    failed = true;
    controller.abort(error);
    // Real transports stop on the signal. If a custom transport replies late,
    // remove its late staging as well; it can never reach the loader above.
    void work
      .finally(async () => {
        try {
          await cleanup();
        } finally {
          if (localDir) await fs.rm(localDir, { recursive: true, force: true });
        }
      })
      .catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    body.destroy();
    try {
      await cleanup();
    } catch (error) {
      if (!failed) throw error;
    } finally {
      if (localDir) await fs.rm(localDir, { recursive: true, force: true });
    }
  }
}

/** Restore an archive through the same command transport as logical dumps. */
export async function receiveCommandArchive(
  pipe: (cmd: string[], body: Readable, opts?: ExecuteCommandOpts) => Promise<ExecExitInfo>,
  target: string,
  body: Readable,
  opts?: ReceiveStreamOpts,
): Promise<{ bytesWritten: number }> {
  // Volume IDs become host paths only in these non-Docker executors.
  if (
    !target.startsWith("/") ||
    target.split("/").includes("..") ||
    target.includes("\0") ||
    posix.normalize(target) === "/"
  ) {
    throw new Error("An absolute, non-root restore path is required");
  }
  const codec = opts?.compression ?? "zstd";
  const tool = codec === "zstd" ? "zstd" : codec === "gzip" ? "gzip" : null;
  const quoted = shellQuote(target);
  const prelude = [
    tool
      ? `command -v ${tool} >/dev/null 2>&1 || { echo "openship: '${tool}' is not installed on this host; your data is untouched." >&2; exit 90; }`
      : "",
    `command -v tar >/dev/null 2>&1 || exit 90`,
    `mkdir -p ${quoted} || exit 91`,
    opts?.clearTarget
      ? `find ${quoted} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || exit 91`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  let bytesWritten = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      bytesWritten += chunk.byteLength;
      done(null, chunk);
    },
  });
  const transfer = pipeline(body, counter, { signal: opts?.signal });
  void transfer.catch(() => {});
  try {
    const exit = await pipe(
      safeRestoreCommand(codec, `tar -x -C ${quoted}`, prelude),
      counter,
      opts,
    );
    if (exit.code !== 0)
      throw new Error(
        `receiveStream tar-extract exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    await transfer;
    return { bytesWritten };
  } finally {
    counter.destroy();
    body.destroy();
    await transfer.catch(() => {});
  }
}
