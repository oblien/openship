/**
 * Command execution — local and SSH implementations.
 *
 * This is the core abstraction that makes the entire system layer work
 * on both local and remote servers. Every check, installer, and file
 * operation goes through a CommandExecutor.
 *
 * Local path:  child_process + node:fs   (server IS the machine)
 * Remote path: ssh2 + SFTP              (server is accessed via SSH)
 *
 * The executor is created once during platform init and injected into
 * the system manager and infra providers.
 */

import { exec, spawn } from "node:child_process";
import {
  access,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { CommandExecutor, LogEntry, SshConfig } from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Shell-quote a value for use in `sh -c` commands. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function logEntry(
  message: string,
  level: LogEntry["level"] = "info",
): LogEntry {
  return { timestamp: new Date().toISOString(), message, level };
}

// ─── Local executor ──────────────────────────────────────────────────────────

/**
 * Runs commands on the local machine via child_process.
 * File operations use node:fs directly.
 */
export class LocalExecutor implements CommandExecutor {
  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        { timeout: opts?.timeout ?? 30_000 },
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
      const child = spawn("sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
        detached: true,
      });

      // Detach from parent event loop so the process doesn't hold it open
      child.unref();

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
      await fsRm(path);
    } catch {
      // Already gone
    }
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for local execution
  }
}

// ─── SSH executor ────────────────────────────────────────────────────────────

/**
 * Runs commands on a remote server via SSH.
 * File operations use SFTP.
 *
 * The SSH connection is established lazily on first use and reused for
 * all subsequent operations. Call `dispose()` to close the connection.
 *
 * Security: key-based auth only — no password auth.
 */
export class SshExecutor implements CommandExecutor {
  private client: import("ssh2").Client | null = null;
  private readonly config: SshConfig;

  constructor(config: SshConfig) {
    if (!config.privateKey && !config.sshAgent) {
      throw new Error(
        "SSH requires either privateKey or sshAgent. " +
          "Password auth is not supported.",
      );
    }
    this.config = config;
  }

  /** Lazily establish the SSH connection. */
  private async connect(): Promise<import("ssh2").Client> {
    if (this.client) return this.client;

    const { Client } = await import("ssh2");
    this.client = new Client();

    return new Promise((resolve, reject) => {
      this.client!.on("ready", () => resolve(this.client!));
      this.client!.on("error", (err) => {
        this.client = null;
        reject(err);
      });

      this.client!.connect({
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.username ?? "root",
        privateKey: this.config.privateKey,
        passphrase: this.config.privateKeyPassphrase,
        agent: this.config.sshAgent,
        tryKeyboard: false,
      });
    });
  }

  /** Get an SFTP session from the active connection. */
  private async sftp(): Promise<import("ssh2").SFTPWrapper> {
    const client = await this.connect();
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    const client = await this.connect();
    const timeout = opts?.timeout ?? 30_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
      }, timeout);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Exit code ${code}`));
          } else {
            resolve(stdout.trim());
          }
        });
      });
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    const connectAndExec = async (): Promise<{ code: number; output: string }> => {
      const client = await this.connect();
      const envPrefix = "export DEBIAN_FRONTEND=noninteractive && ";

      return new Promise((resolve, reject) => {
        client.exec(envPrefix + command, (err, stream) => {
          if (err) return reject(err);

          const chunks: string[] = [];

          stream.on("data", (data: Buffer) => {
            const text = data.toString();
            for (const raw of text.split("\n")) {
              const line = raw.trimEnd();
              if (line) {
                chunks.push(line);
                onLog(logEntry(line));
              }
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            const text = data.toString();
            for (const raw of text.split("\n")) {
              const line = raw.trimEnd();
              if (line) {
                chunks.push(line);
                onLog(logEntry(line, "warn"));
              }
            }
          });

          stream.on("close", (code: number) => {
            resolve({ code: code ?? 1, output: chunks.join("\n") });
          });
        });
      });
    };

    return connectAndExec();
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Ensure parent directory exists
    const dir = dirname(path);
    try {
      await this.exec(`mkdir -p ${sq(dir)}`);
    } catch {
      // Best effort
    }

    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.writeFile(path, content, { encoding: "utf-8" }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async readFile(path: string): Promise<string> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(path, { encoding: "utf-8" }, (err, data) => {
        if (err) reject(err);
        else resolve(data.toString());
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    const sftp = await this.sftp();
    return new Promise((resolve) => {
      sftp.stat(path, (err) => {
        resolve(!err);
      });
    });
  }

  async mkdir(path: string): Promise<void> {
    // SFTP mkdir isn't recursive — use exec with sq() for safe quoting
    await this.exec(`mkdir -p ${sq(path)}`);
  }

  async rm(path: string): Promise<void> {
    const sftp = await this.sftp();
    return new Promise((resolve) => {
      sftp.unlink(path, () => resolve()); // Silently ignore if gone
    });
  }

  async dispose(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the right executor based on whether SSH config is provided.
 * No SSH config → local executor (commands run on this machine).
 * SSH config   → remote executor (commands run on the remote server).
 */
export function createExecutor(ssh?: SshConfig): CommandExecutor {
  if (ssh) {
    return new SshExecutor(ssh);
  }
  return new LocalExecutor();
}
