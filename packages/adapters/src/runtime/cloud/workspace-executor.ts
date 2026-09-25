import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { posix } from "node:path";
import type { Runtime } from "oblien";
import type { CommandExecutor, LogCallback } from "../../types";
import { BuildLogger, sq } from "../build-pipeline";
import { transferLocalDirectory } from "../transfer";

/** Files, builds, and streams execute only inside the bound customer workspace. */
export class CloudWorkspaceExecutor implements CommandExecutor {
  private readonly abortScope = new AsyncLocalStorage<AbortSignal>();
  private readonly tasks = new Set<() => void>();
  private disposed = false;

  constructor(private readonly runtime: () => Promise<Runtime>) {}

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
    let killSent = false;
    const cancellation = new AbortController();
    let rejectCancellation!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const stopTask = () => {
      if (taskId && !killSent) {
        killSent = true;
        void runtime.exec.kill(taskId).catch(() => {});
      }
    };
    const kill = () => {
      killed = true;
      stopTask();
      const error = new Error("Cloud command cancelled");
      cancellation.abort(error);
      rejectCancellation(error);
    };
    this.tasks.add(kill);
    const signal = this.abortScope.getStore();
    signal?.addEventListener("abort", kill, { once: true });
    const write = async (target: PassThrough, bytes: Buffer | string) => {
      cancellation.signal.throwIfAborted();
      if (target.destroyed) throw new Error("Cloud command output stream closed");
      if (!target.write(bytes)) await once(target, "drain", { signal: cancellation.signal });
    };
    const markerName = `openship-exit-${randomUUID()}:`;
    const marker = Buffer.from(`\x1e${markerName}`);
    let pending = Buffer.alloc(0);
    let verifiedExit: number | undefined;
    const output = async (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      const at = pending.indexOf(marker);
      if (at >= 0) {
        if (at) await write(stdout, pending.subarray(0, at));
        pending = pending.subarray(at);
        const end = pending.indexOf(0x1f, marker.length);
        if (end < 0) {
          if (pending.length > marker.length + 3) throw new Error("Invalid cloud command exit frame");
          return;
        }
        const value = pending.subarray(marker.length, end).toString("ascii");
        if (!/^\d{1,3}$/.test(value) || Number(value) > 255 || verifiedExit !== undefined) throw new Error("Invalid cloud command exit frame");
        verifiedExit = Number(value);
        pending = pending.subarray(end + 1);
      }
      // Retain only a possible split marker. Everything else streams normally,
      // including arbitrary binary bytes; the marker never reaches consumers.
      const available = verifiedExit === undefined ? pending.length - marker.length + 1 : pending.length;
      if (available > 0) {
        await write(stdout, pending.subarray(0, available));
        pending = pending.subarray(available);
      }
    };
    const consume = (async () => {
      let code: number | undefined;
      try {
        // Some Oblien Linux runtimes allocate a PTY even in direct mode. Turn
        // off its output processing before executing anything: ONLCR otherwise
        // silently inserts CR bytes into docker save / archive streams.
        // The PTY-backed runtime can report exit 1 after a successful command.
        // Carry the shell's real status in a private frame, independently of
        // the provider's process/PTY close status.
        const script = `if [ -t 1 ]; then stty -opost -echo <&1 || exit $?; fi\nsh -c ${sq(command)}\nopenship_exec_status=$?\nprintf '\\036${markerName}%s\\037' "$openship_exec_status"\nexit "$openship_exec_status"`;
        for await (const event of runtime.exec.stream(["sh", "-c", script], {
          execMode: "direct", timeoutSeconds: opts?.timeoutSeconds ?? 3600, keepLogs: false,
        })) {
          if (event.event === "task_id") {
            taskId = event.task_id;
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
        if (pending.length) await write(stdout, pending);
        if (verifiedExit === undefined && code === 0) throw new Error("Cloud command ended without a verified exit status");
        return code;
      } catch (error) {
        killed = true;
        stopTask();
        cancellation.abort(error);
        throw error;
      }
    })();
    const onClose = Promise.race([consume, cancelled]).finally(() => {
        this.tasks.delete(kill);
        signal?.removeEventListener("abort", kill);
        stdout.end();
        stderr.end();
    });
    if (signal?.aborted) kill();
    // Consumers attach their close listener after this async method returns.
    void onClose.catch(() => {});
    return { stdout, stderr, onClose, kill };
  }

  async streamExec(command: string, onLog: LogCallback, opts?: { signal?: AbortSignal }): Promise<{ code: number; output: string }> {
    opts?.signal?.throwIfAborted();
    const child = await this.rawExec(command);
    let output = "";
    const collect = (data: Buffer, level: "info" | "error") => {
      const message = data.toString("utf8");
      // Preserve a bounded tail for failures; large builds stream to their log sink.
      output = (output + message).slice(-2 * 1024 * 1024);
      onLog({ timestamp: new Date().toISOString(), message, level });
    };
    child.stdout.on("data", data => collect(data, "info"));
    child.stderr.on("data", data => collect(data, "error"));
    opts?.signal?.addEventListener("abort", child.kill, { once: true });
    if (opts?.signal?.aborted) child.kill();
    try {
      const code = await child.onClose;
      opts?.signal?.throwIfAborted();
      return { code, output };
    } finally {
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
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const kill of this.tasks) kill();
  }
}
