import { exec, spawn } from "node:child_process";
import {
  access,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { CommandExecutor, LogEntry } from "../types";
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
  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
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
          if (err) reject(new Error(stderr.trim() || err.message));
          else resolve(stdout.trim());
        },
      );
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(getLocalShellPath(), getLocalShellArgs(command), {
        stdio: ["ignore", "pipe", "pipe"],
        env: getLocalExecEnv(),
      });

      const chunks: string[] = [];

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        for (const raw of text.split("\n")) {
          const line = raw.trimEnd();
          if (line) {
            chunks.push(line);
            onLog(logEntry(line));
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        for (const raw of text.split("\n")) {
          const line = raw.trimEnd();
          if (line) {
            chunks.push(line);
            onLog(logEntry(line, "warn"));
          }
        }
      });

      child.on("close", (code) => {
        resolve({ code: code ?? 1, output: chunks.join("\n") });
      });

      child.on("error", (err) => {
        onLog(logEntry(`Process error: ${err.message}`, "error"));
        resolve({ code: 1, output: err.message });
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    await fsWriteFile(path, content, "utf-8");
  }

  async readFile(path: string): Promise<string> {
    return fsReadFile(path, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fsMkdir(path, { recursive: true });
  }

  async rm(path: string): Promise<void> {
    try {
      await fsRm(path, { recursive: true, force: true });
    } catch {
      // Already gone
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[] },
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
    // Nothing to clean up for local execution
  }
}