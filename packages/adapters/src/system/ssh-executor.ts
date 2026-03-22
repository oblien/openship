import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { getTarCreateEnv } from "../archive";
import type { CommandExecutor, LogEntry, SshConfig } from "../types";
import { logEntry, sq } from "./local-shell";
import {
  canUseRemoteRsync,
  transferRemoteDirectoryWithRsync,
  transferRemoteDirectoryWithTar,
} from "./remote-transfer";
import { describeSshAuthFailure, reconcileKnownHosts } from "./ssh-support";
import { isSshAuthError } from "./errors";

/**
 * Runs commands on a remote server via SSH.
 * File operations use SFTP.
 */
export class SshExecutor implements CommandExecutor {
  private client: import("ssh2").Client | null = null;
  private connecting: Promise<import("ssh2").Client> | null = null;
  private readonly config: SshConfig;

  constructor(config: SshConfig) {
    if (!config.privateKey && !config.sshAgent && !config.password) {
      throw new Error("SSH requires one of privateKey, sshAgent, or password.");
    }
    this.config = config;
  }

  private async connect(): Promise<import("ssh2").Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      await reconcileKnownHosts(this.config);

      const { Client } = await import("ssh2");
      const client = new Client();

      return new Promise<import("ssh2").Client>((resolve, reject) => {
        let settled = false;

        const resetClient = () => {
          if (this.client === client) {
            this.client = null;
          }
        };

        client.on("ready", () => {
          if (settled) return;
          settled = true;
          this.client = client;
          this.connecting = null;
          resolve(client);
        });

        client.on("error", (err) => {
          resetClient();
          if (settled) return;
          settled = true;
          this.connecting = null;
          if (isSshAuthError(err)) {
            reject(new Error(describeSshAuthFailure(this.config, err.message)));
            return;
          }
          reject(err);
        });

        client.on("close", () => {
          resetClient();
          if (settled) return;
          settled = true;
          this.connecting = null;
          reject(new Error("SSH connection closed before ready"));
        });

        client.on("end", () => {
          resetClient();
        });

        client.connect({
          host: this.config.host,
          port: this.config.port ?? 22,
          username: this.config.username ?? "root",
          password: this.config.password,
          privateKey: this.config.privateKey,
          passphrase: this.config.privateKeyPassphrase,
          agent: this.config.sshAgent,
          tryKeyboard: false,
        });
      });
    })();

    return this.connecting;
  }

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
    await this.exec(`mkdir -p ${sq(path)}`);
  }

  async rm(path: string): Promise<void> {
    try {
      await this.exec(`rm -rf ${sq(path)}`);
    } catch {
      // Already gone
    }
  }

  async dispose(): Promise<void> {
    this.connecting = null;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  private async pipeLocal(
    localCmd: string,
    remoteCmd: string,
    onLog?: (log: LogEntry) => void,
  ): Promise<{ code: number }> {
    const client = await this.connect();

    return new Promise((resolve, reject) => {
      client.exec(remoteCmd, (err, channel) => {
        if (err) return reject(err);

        const local = spawn("sh", ["-c", localCmd], {
          stdio: ["ignore", "pipe", "pipe"],
          env: getTarCreateEnv(),
        });

        local.stdout.pipe(channel);

        local.stderr.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text && onLog) onLog(logEntry(text, "warn"));
        });

        channel.stderr.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text && onLog) onLog(logEntry(text, "warn"));
        });

        channel.on("close", (code: number) => {
          resolve({ code: code ?? 1 });
        });

        local.on("error", (e) => {
          reject(new Error(`Local process failed: ${e.message}`));
        });
      });
    });
  }

  private async hasRemoteCommand(command: string): Promise<boolean> {
    try {
      await this.exec(`command -v ${command} >/dev/null 2>&1 && echo ok`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[] },
  ): Promise<void> {
    const deps = {
      config: this.config,
      hasRemoteCommand: (command: string) => this.hasRemoteCommand(command),
      ensureRemoteDir: (path: string) => this.exec(`mkdir -p ${sq(path)}`).then(() => undefined),
      pipeLocal: (
        localCmd: string,
        remoteCmd: string,
        logCb?: (log: LogEntry) => void,
      ) => this.pipeLocal(localCmd, remoteCmd, logCb),
    };

    const rsync = await canUseRemoteRsync(deps);
    if (rsync.ok) {
      await transferRemoteDirectoryWithRsync(localPath, remotePath, deps, onLog, options);
      return;
    }

    onLog?.(logEntry(`rsync unavailable (${rsync.reason}); falling back to tar stream transfer.`, "warn"));
    await transferRemoteDirectoryWithTar(localPath, remotePath, deps, onLog, options);
  }
}