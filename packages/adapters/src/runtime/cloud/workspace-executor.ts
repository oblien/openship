import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { posix } from "node:path";
import type { Runtime } from "oblien";
import { AppError, type ManagedCommandRef } from "@repo/core";
import type { CommandExecutor, LogCallback, ShellOptions, ShellSession } from "../../types";
import { BuildLogger, sq } from "../build-pipeline";
import { transferLocalDirectory } from "../transfer";
import { openCloudShell } from "./shell";
import { CLOUD_EXEC_FRAMING } from "./exec-framing";
import { releaseTask, stopCommand, recoverManagedCommand } from "./command-recovery";
import { currentManagedCommandTracking } from "./command-tracking";

/** Files, builds, and streams execute only inside the bound customer workspace. */
export class CloudWorkspaceExecutor implements CommandExecutor {
  private readonly abortScope = new AsyncLocalStorage<AbortSignal>();
  private readonly tasks = new Map<() => void, Promise<unknown>>();
  private readonly shells = new Set<ShellSession>();
  private disposed = false;

  constructor(private readonly runtime: () => Promise<Runtime>, private readonly workspaceId?: string) {}

  async recoverCommand(command: ManagedCommandRef) {
    if (command.workspaceId !== this.workspaceId) throw new Error("Command belongs to another server");
    await recoverManagedCommand(await this.rt(), command);
  }

  runWithAbortSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    return this.abortScope.run(signal, fn);
  }

  private async rt(): Promise<Runtime> {
    if (this.disposed) throw new Error("Cloud workspace connection is closed");
    this.abortScope.getStore()?.throwIfAborted();
    return this.runtime();
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    const controller = new AbortController();
    const outer = this.abortScope.getStore();
    const abort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", abort, { once: true });
    if (outer?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Cloud command timed out")), opts?.timeout ?? 120_000);
    try {
      const result = await this.streamExec(command, () => {}, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (result.code !== 0) throw new Error(result.output || `Cloud command exited with code ${result.code}`);
      return result.output;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
    }
  }

  async rawExec(command: string, opts?: { timeoutSeconds?: number }): Promise<Awaited<ReturnType<NonNullable<CommandExecutor["rawExec"]>>>> {
    const runtime = await this.rt();
    const stdout = new PassThrough({ highWaterMark: 1024 * 1024 });
    const stderr = new PassThrough({ highWaterMark: 1024 * 1024 });
    stdout.on("error", () => {});
    stderr.on("error", () => {});
    let taskId: string | undefined;
    let killed = false;
    let stopping: Promise<void> | undefined;
    const markerName = `openship-exec-${randomUUID()}:`;
    const tracking = currentManagedCommandTracking();
    if (tracking && !this.workspaceId) throw new Error("Managed command is missing its server identity");
    const identity = () => ({ workspaceId: this.workspaceId!, marker: markerName, ...(taskId ? { taskId } : {}) });
    await tracking?.record(identity());
    let verifiedExit: number | undefined;
    const cancellation = new AbortController();
    let rejectCancellation!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const stopTask = (): Promise<void> => {
      return stopping ??= (async () => {
        if (verifiedExit === undefined) {
          await stopCommand(runtime, markerName, taskId);
        } else {
          // A verified exit may still leave a retained provider task slot.
          if (taskId) await releaseTask(runtime, taskId);
        }
        await tracking?.complete(markerName);
      })();
    };
    const kill = () => {
      killed = true;
      const error = new Error("Cloud command cancelled");
      cancellation.abort(error);
      // Keep the caller's operation lock until the provider acknowledges the
      // stop. An ID arriving after cancellation must be stopped as well.
      void stopTask().then(() => rejectCancellation(error), rejectCancellation);
    };
    const signal = this.abortScope.getStore();
    signal?.addEventListener("abort", kill, { once: true });
    const write = async (target: PassThrough, bytes: Buffer | string) => {
      cancellation.signal.throwIfAborted();
      if (target.destroyed) throw new Error("Cloud command output stream closed");
      if (!target.write(bytes)) await once(target, "drain", { signal: cancellation.signal });
    };
    const marker = Buffer.from(`\x1e${markerName}`);
    let pending = Buffer.alloc(0);
    const output = async (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length) {
        if (pending.length < marker.length) return;
        if (!pending.subarray(0, marker.length).equals(marker))
          throw new Error("Managed command framing is unavailable. Check Python on the server.");
        const separator = pending.indexOf(0x1f, marker.length);
        if (separator < 0) {
          if (pending.length > marker.length + 8) throw new Error("Invalid cloud command frame");
          return;
        }
        const header = /^([oex]):(\d{1,5})$/.exec(pending.subarray(marker.length, separator).toString("ascii"));
        if (!header || Number(header[2]) > 32768 || verifiedExit !== undefined)
          throw new Error("Invalid cloud command frame");
        const length = Number(header[2]);
        if (pending.length < separator + 1 + length) return;
        const payload = pending.subarray(separator + 1, separator + 1 + length);
        pending = pending.subarray(separator + 1 + length);
        if (header[1] === "x") {
          const value = payload.toString("ascii");
          if (!/^\d{1,3}$/.test(value) || Number(value) > 255) throw new Error("Invalid cloud command exit frame");
          verifiedExit = Number(value);
        } else await write(header[1] === "o" ? stdout : stderr, payload);
      }
    };
    const consume = (async () => {
      let code: number | undefined;
      try {
        // Disable PTY byte rewriting, then carry separate pipe output and the
        // actual command status independently of the provider's PTY close code.
        const script = `if [ -t 1 ]; then stty -opost -echo <&1 || exit $?; fi\nexec python3 -u -c ${sq(CLOUD_EXEC_FRAMING)} ${sq(command)} ${sq(markerName)}`;
        for await (const event of runtime.exec.stream(["sh", "-c", script], {
          execMode: "direct", timeoutSeconds: opts?.timeoutSeconds ?? 3600, keepLogs: false,
        })) {
          if (event.event === "task_id") {
            taskId = event.task_id;
            if (killed) {
              await stopTask();
              await releaseTask(runtime, taskId);
              throw new Error("Cloud command cancelled");
            }
            await tracking?.record(identity());
            if (killed || signal?.aborted) kill();
          } else if (event.event === "stdout" || event.event === "stderr") {
            const bytes = Buffer.from(event.data, "base64");
            if (event.event === "stdout") await output(bytes); else await write(stderr, bytes);
          } else if (event.event === "output") {
            if (event.stdout) await output(Buffer.from(event.stdout));
            if (event.stderr) await write(stderr, event.stderr);
          } else if (event.event === "exit") {
            code = verifiedExit ?? event.exit_code;
            break;
          }
        }
        if (code === undefined) throw new Error("Cloud command ended without an exit status");
        if (pending.length) throw new Error("Cloud command ended with an incomplete output frame");
        if (verifiedExit === undefined && code === 0) throw new Error("Cloud command ended without a verified exit status");
        // Streamed tasks retain their result slot even with keepLogs:false.
        // Release this task before the next setup command starts; Supabase's
        // generated files alone can otherwise fill the runtime's 50 slots.
        await stopTask();
        return code;
      } catch (error) {
        killed = true;
        cancellation.abort(error);
        await stopTask();
        throw error;
      }
    })();
    const onClose = Promise.race([consume, cancelled]).finally(() => {
        this.tasks.delete(kill);
        signal?.removeEventListener("abort", kill);
        stdout.end();
        stderr.end();
    });
    this.tasks.set(kill, onClose);
    if (signal?.aborted) kill();
    // Consumers attach their close listener after this async method returns.
    void onClose.catch(() => {});
    return { stdout, stderr, onClose, kill };
  }

  async streamExec(command: string, onLog: LogCallback, opts?: { signal?: AbortSignal }): Promise<{ code: number; output: string }> {
    opts?.signal?.throwIfAborted();
    const child = await this.rawExec(command);
    let output = "";
    const decoders = { info: new StringDecoder("utf8"), error: new StringDecoder("utf8") };
    const emit = (message: string, level: "info" | "error", rawData: string) => {
      // Preserve a bounded tail for failures; large builds stream to their log sink.
      output = (output + message).slice(-2 * 1024 * 1024);
      onLog({ timestamp: new Date().toISOString(), message, level, rawData });
    };
    const collect = (data: Buffer, level: "info" | "error") =>
      emit(decoders[level].write(data), level, data.toString("base64"));
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      for (const level of ["info", "error"] as const) {
        const remaining = decoders[level].end();
        if (remaining) emit(remaining, level, "");
      }
    };
    child.stdout.on("data", data => collect(data, "info"));
    child.stderr.on("data", data => collect(data, "error"));
    opts?.signal?.addEventListener("abort", child.kill, { once: true });
    if (opts?.signal?.aborted) child.kill();
    try {
      const code = await child.onClose;
      opts?.signal?.throwIfAborted();
      flush();
      return { code, output };
    } finally {
      flush();
      opts?.signal?.removeEventListener("abort", child.kill);
    }
  }

  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    const runtime = await this.rt();
    const temp = `${path}.openship-${randomUUID()}`;
    await this.exec(`umask 077; mkdir -p ${sq(posix.dirname(path))} && : > ${sq(temp)} && chmod ${(opts?.mode ?? 0o600).toString(8)} ${sq(temp)}`);
    try {
      const written = await runtime.files.write({ fullPath: temp, content });
      if (!written.success) throw new Error("Could not write workspace file");
      await this.rename(temp, path);
    } catch (error) {
      await runtime.files.delete({ path: temp }).catch(() => {});
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    const result = await (await this.rt()).files.read({ filePath: path });
    if (!result.success) throw new Error("Could not read workspace file");
    return result.content;
  }
  async exists(path: string): Promise<boolean> {
    return (await this.exec(`if [ -e ${sq(path)} ]; then printf yes; else printf no; fi`)).trim() === "yes";
  }
  async mkdir(path: string): Promise<void> { await this.exec(`mkdir -p ${sq(path)}`); }
  async rm(path: string): Promise<void> {
    if (!path.startsWith("/") || posix.normalize(path) === "/" || path.split("/").includes("..")) throw new Error("Invalid workspace removal path");
    await this.exec(`rm -rf -- ${sq(path)}`);
  }
  async rename(from: string, to: string): Promise<void> { await this.exec(`mv -- ${sq(from)} ${sq(to)}`); }
  async transferIn(...[localPath, remotePath, onLog, options]: Parameters<CommandExecutor["transferIn"]>): Promise<void> {
    const logger = new BuildLogger(onLog);
    await transferLocalDirectory(localPath, { kind: "cloud-runtime", runtime: await this.rt(), path: remotePath }, logger, options);
  }
  async openShell(options?: ShellOptions): Promise<ShellSession> {
    const shell = await openCloudShell(await this.rt(), options, this.workspaceId);
    if (this.disposed) { await shell.close(); throw new Error("Cloud workspace connection is closed"); }
    this.shells.add(shell);
    shell.onClose(() => this.shells.delete(shell));
    return shell;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const shells = [...this.shells];
    this.shells.clear();
    const tasks = [...this.tasks.entries()];
    for (const [kill] of tasks) kill();
    await Promise.allSettled([...tasks.map(([, completion]) => completion), ...shells.map(shell => shell.close())]);
  }
}
