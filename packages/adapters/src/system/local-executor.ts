import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { AsyncLocalStorage } from "node:async_hooks";
import { exec, spawn } from "node:child_process";
import { pipeline, type Readable } from "node:stream";
import { promisify } from "node:util";
import {
  access,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { assertLocalHostExecutionAllowed } from "@repo/core";

import type { CommandExecutor, FileStat, LogEntry } from "../types";
import { lstatFile } from "./file-stat";
import {
  getLocalExecEnv,
  getLocalShellArgs,
  getLocalShellPath,
  logEntry,
  sq,
} from "./local-shell";

/**
 * Runs commands on the local machine via child_process.
 * File operations use node:fs directly.
 */
export class LocalExecutor implements CommandExecutor {
  private readonly abortScope = new AsyncLocalStorage<AbortSignal>();
  private readonly activeRawCommands = new Set<{ kill: () => void; onClose: Promise<number> }>();

  runWithAbortSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return this.abortScope.run(signal, work);
  }

  /** Binary transport for self-hosted/desktop workloads. Never available to a
   * Cloud controller, including when this executor predates mode initialization. */
  private async spawnRawCommand(command: string) {
    assertLocalHostExecutionAllowed();
    const signal = this.abortScope.getStore();
    signal?.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(getLocalShellPath(), getLocalShellArgs(command), {
      stdio: ["pipe", "pipe", "pipe"],
      env: getLocalExecEnv(),
      detached: grouped,
    });
    let terminating = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const send = (kind: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        // A child can exit between the close event and cancellation.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          observeCaughtError(error, "adapters/system/local-executor");
      }
    };
    const kill = () => {
      if (terminating) return;
      terminating = true;
      send("SIGTERM");
      escalation = setTimeout(() => send("SIGKILL"), 1_000);
      escalation.unref?.();
    };
    const onClose = new Promise<number>((resolve, reject) => {
      let failure: Error | undefined;
      child.once("error", (error) => {
        // diagnostics-ignore: onClose rejects with this failure after stdio closes.
        failure = error;
      });
      child.once("close", (code) => {
        if (terminating && grouped) send("SIGKILL");
        clearTimeout(escalation);
        signal?.removeEventListener("abort", kill);
        this.activeRawCommands.delete(active);
        if (signal?.aborted) reject(signal.reason ?? new Error("Local command cancelled"));
        else if (failure) reject(failure);
        else resolve(code ?? 1);
      });
    });
    // The process can fail before the caller attaches its stream lifecycle.
    void onClose.catch((error) => observeCaughtError(error, "adapters/system/local-executor"));
    const active = { kill, onClose };
    this.activeRawCommands.add(active);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return { child, ...active };
  }

  async rawExec(command: string) {
    const { child, onClose, kill } = await this.spawnRawCommand(command);
    child.stdin.end();
    return { stdout: child.stdout, stderr: child.stderr, onClose, kill };
  }

  async execWithInput(command: string, body: Readable) {
    const { child, onClose, kill } = await this.spawnRawCommand(command);
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(-16 * 1024); });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16 * 1024); });
    let inputError: NodeJS.ErrnoException | undefined;
    const input = promisify(pipeline)(body, child.stdin).catch((error) => {
      // diagnostics-ignore: propagated below after the subprocess and input settle.
      inputError = error;
      kill();
    });
    try {
      const code = await onClose;
      await input;
      if (inputError && (code === 0 || !["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(inputError.code ?? "")))
        throw inputError;
      return { code, stderr: stderr.trim(), stdout: stdout.trim() };
    } finally {
      // Await upstream teardown before a restore releases its execution lock.
      await input;
    }
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    assertLocalHostExecutionAllowed();
    return new Promise((resolve, reject) => {
      const shell = getLocalShellPath();
      exec(
        command,
        {
          timeout: opts?.timeout ?? 30_000,
          shell,
          env: getLocalExecEnv(),
        },
        (err, stdout, stderr) => {
          // Fold BOTH streams into the failure error. Many CLIs (certbot in
          // particular) print the real cause to stdout while stderr only carries
          // boilerplate ("Saving debug log to …"); dropping stdout hid the reason.
          if (err) {
            const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
            reject(new Error(detail || err.message));
          } else resolve(stdout.trim());
        },
      );
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
    opts?: { signal?: AbortSignal; killProcessTree?: boolean },
  ): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      assertLocalHostExecutionAllowed();
      // Already told to stop before we even spawned (a stream torn down immediately).
      if (opts?.signal?.aborted) {
        resolve({ code: 0, output: "" });
        return;
      }

      const killProcessTree = opts?.killProcessTree === true && process.platform !== "win32";
      const child = spawn(getLocalShellPath(), getLocalShellArgs(command), {
        stdio: ["ignore", "pipe", "pipe"],
        env: getLocalExecEnv(),
        detached: killProcessTree,
      });

      // Raw passthrough: forward the untouched byte stream (rawData = base64)
      // so the client's xterm renders carriage returns / ANSI natively —
      // progress lines (git clone, npm, next build) repaint in place instead
      // of flooding new lines. We keep the decoded text in `chunks` for the
      // returned `output` (build-kill-hint detection + persistence fallback).
      // Do NOT split on "\n" or trim here — that is exactly what destroyed the
      // "\r" carriage returns and made every progress tick its own line.
      // Bounded: a live tail (the exec log transport) can run for the length of a
      // session, so cap what we retain for `output` — the last N chunks are all any
      // caller reads (kill-hint detection, an error tail), and unbounded growth here
      // would be a slow leak.
      const MAX_RETAINED_CHUNKS = 200;
      const chunks: string[] = [];

      const onChunk = (data: Buffer, level: LogEntry["level"]) => {
        const text = data.toString();
        if (!text) return;
        chunks.push(text);
        if (chunks.length > MAX_RETAINED_CHUNKS) chunks.shift();
        onLog(logEntry(text, level, data.toString("base64")));
      };

      // Kill the child when the caller aborts. `curl -sN` held open by the exec log
      // transport only ends on the edge closing or on this kill; without it a torn-down
      // browser stream leaves the curl draining the edge's shared queue.
      const signal = opts?.signal;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (killProcessTree && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch (diagnosticFailure) {
          observeCaughtError(diagnosticFailure, "adapters/system/local-executor"); /* process already exited */ }
      };
      const onAbort = () => {
        kill("SIGTERM");
        if (killProcessTree) {
          killTimer = setTimeout(() => kill("SIGKILL"), 1_000);
          killTimer.unref?.();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
        // The shell can exit before a grandchild that redirected its stdio.
        // Reap the remaining group before reporting cancellation complete.
        if (signal?.aborted && killProcessTree) kill("SIGKILL");
      };

      child.stdout.on("data", (data: Buffer) => onChunk(data, "info"));
      child.stderr.on("data", (data: Buffer) => onChunk(data, "warn"));

      child.on("close", (code) => {
        cleanup();
        resolve({ code: code ?? 1, output: chunks.join("") });
      });

      child.on("error", (err) => { observeCaughtError(err, "adapters/system/local-executor");
        cleanup();
        onLog(logEntry(`Process error: ${err.message}`, "error"));
        resolve({ code: 1, output: err.message });
      });
    });
  }

  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    if (opts?.mode === undefined) {
      await fsWriteFile(path, content, "utf-8");
      return;
    }

    // `mode` on writeFile only applies when the path is newly created. Open +
    // fchmod first also tightens an existing path before any new payload bytes
    // are written.
    const file = await fsOpen(path, "w", opts.mode);
    try {
      await file.chmod(opts.mode);
      await file.writeFile(content, "utf-8");
    } finally {
      await file.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await fsRename(from, to);
  }

  async readFile(path: string): Promise<string> {
    return fsReadFile(path, "utf-8");
  }

  async lstat(path: string): Promise<FileStat | null> {
    return lstatFile(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/system/local-executor");
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fsMkdir(path, { recursive: true });
  }

  async rm(path: string): Promise<void> {
    try {
      await fsRm(path, { recursive: true, force: true });
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/system/local-executor");
      // Already gone
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    // alsoInclude is a no-op here: the `cp -a .` fallback already copies the
    // whole built tree (build output included) with no git/exclude filtering.
    options?: { excludes?: string[]; includes?: string[]; alsoInclude?: string[] },
  ): Promise<void> {
    const log = onLog ?? (() => {});

    if (options?.includes?.length) {
      for (const p of options.includes) {
        const { code } = await this.streamExec(
          `cp -a ${sq(localPath + "/" + p)} ${sq(remotePath + "/" + p)}`,
          log,
        );
        if (code !== 0) throw new Error(`Failed to copy ${p}`);
      }
      return;
    }

    const { code } = await this.streamExec(
      `cp -a ${sq(localPath + "/")}. ${sq(remotePath)}`,
      log,
    );
    if (code !== 0) throw new Error("Failed to copy local project files");
  }

  async dispose(): Promise<void> {
    const commands = [...this.activeRawCommands];
    for (const command of commands) command.kill();
    await Promise.allSettled(commands.map((command) => command.onClose));
  }
}
