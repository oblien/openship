import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { CommandExecutor } from "../../types";
import type { ExecuteCommandOpts, ExecExitInfo } from "../types";
import { watchArtifactConsumer } from "./artifact-stream";

export const CAPTURE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const CAPTURE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type RawCommand = Awaited<ReturnType<NonNullable<CommandExecutor["rawExec"]>>>;

/** Shared capture lifecycle for SSH and the workspace command transport. */
export function captureCommandOutput(child: RawCommand, opts?: ExecuteCommandOpts) {
  const stdout = new PassThrough({ highWaterMark: 1024 * 1024 });
  stdout.on("error", (eventDiagnosticError) => { observeCaughtError(eventDiagnosticError, "adapters/backup/common/command-stream"); });
  const consumer = watchArtifactConsumer(stdout, "Backup command");
  let stderr = "";
  let idle: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const idleMs = opts?.idleTimeoutMs ?? CAPTURE_IDLE_TIMEOUT_MS;
  const timeoutMs = opts?.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        rejectFailure(
          new Error(`Backup command produced no data for ${Math.round(idleMs / 1000)}s`),
        ),
      idleMs,
    );
    idle.unref?.();
  };
  const ceiling = setTimeout(
    () =>
      rejectFailure(
        new Error(`Backup command exceeded its ${Math.round(timeoutMs / 1000)}s ceiling`),
      ),
    timeoutMs,
  );
  ceiling.unref?.();
  const onStderr = (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16 * 1024);
    touch();
  };
  const onError = (error: Error) => {
    // The process may still run after stdout reaches EOF. Destroying that
    // already-closed stream cannot signal cancellation or a later stderr error.
    rejectFailure(error);
    stdout.destroy(error);
  };
  const onAbort = () =>
    onError(
      opts?.signal?.reason instanceof Error
        ? opts.signal.reason
        : new Error("Backup command cancelled"),
    );
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts?.signal?.aborted) onAbort();
  child.stdout.on("error", onError);
  child.stderr.on("error", onError);
  // The pass-through retains bytes until the consumer attaches and propagates
  // backpressure. Observing the raw stream directly without this pipe would
  // start it flowing before its first bytes had a reader.
  child.stdout.pipe(stdout);
  child.stdout.on("data", touch);
  child.stderr.on("data", onStderr);
  stdout.on("drain", touch);
  touch();
  const awaitExit = (async (): Promise<ExecExitInfo> => {
    try {
      const [code] = await Promise.race([
        Promise.all([child.onClose, finished(stdout, { readable: false, cleanup: true })]),
        consumer.promise,
        failure,
      ]);
      return { code, stderr };
    } catch (error) {
      try {
        child.kill();
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "adapters/backup/common/command-stream");
        /* channel already closed */
      }
      child.stdout.unpipe(stdout);
      child.stdout.destroy();
      child.stderr.destroy();
      stdout.destroy(error as Error);
      throw error;
    } finally {
      clearTimeout(idle);
      clearTimeout(ceiling);
      consumer.dispose();
      opts?.signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", touch);
      child.stderr.off("data", onStderr);
      stdout.off("drain", touch);
    }
  })();
  void awaitExit.catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "adapters/backup/common/command-stream");
  });
  return { stdout, awaitExit };
}
