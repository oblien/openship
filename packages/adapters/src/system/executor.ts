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

import { exec, execFile, spawn } from "node:child_process";
import {
  access,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { CommandExecutor, LogEntry, SshConfig } from "../types";
import { systemDebug } from "./debug";
import { isSshAuthError } from "./errors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Shell-quote a value for use in `sh -c` commands. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const LOCAL_BUILD_ENV_KEYS = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
] as const;

function logEntry(
  message: string,
  level: LogEntry["level"] = "info",
): LogEntry {
  return { timestamp: new Date().toISOString(), message, level };
}

function formatSshTarget(config: SshConfig): string {
  return `${config.username ?? "root"}@${config.host}:${config.port ?? 22}`;
}

function describeSshAuthFailure(config: SshConfig, originalMessage: string): string {
  const target = formatSshTarget(config);

  if (config.password) {
    return `SSH password authentication failed for ${target}. Check the username/password, or verify that the server allows password login. (${originalMessage})`;
  }

  if (config.privateKey || config.sshAgent) {
    return `SSH key authentication failed for ${target}. Check the username, private key, passphrase, or whether the server accepts this key. (${originalMessage})`;
  }

  return `SSH authentication failed for ${target}. (${originalMessage})`;
}

function execFileText(
  command: string,
  args: string[],
  timeout = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || stdout.trim() || err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseKnownHostsEntries(text: string): Set<string> {
  const entries = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      entries.add(`${parts[1]} ${parts[2]}`);
    }
  }

  return entries;
}

function getLocalShellPath(): string {
  return process.env.SHELL?.trim() || "/bin/sh";
}

function getLocalShellArgs(command: string): string[] {
  const shellName = basename(getLocalShellPath());

  // Use the user's shell when possible so local bare builds behave like
  // a normal terminal command, but avoid assuming every shell supports -l.
  if (shellName === "bash" || shellName === "zsh") {
    return ["-lc", command];
  }

  return ["-c", command];
}

function getLocalExecEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
}

function buildIsolatedLocalEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DEBIAN_FRONTEND: "noninteractive" };

  for (const key of LOCAL_BUILD_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
  }

  return env;
}

export function wrapLocalBuildCommand(command: string, envOverrides?: NodeJS.ProcessEnv): string {
  const shellPath = getLocalShellPath();
  const envVars = buildIsolatedLocalEnv(envOverrides);
  const envAssignments = Object.entries(envVars)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${sq(value)}`)
    .join(" ");

  return `env -i ${envAssignments} ${sq(shellPath)} ${getLocalShellArgs(command).map(sq).join(" ")}`;
}

async function reconcileKnownHosts(config: SshConfig): Promise<void> {
  const knownHostsPath = join(homedir(), ".ssh", "known_hosts");

  try {
    await access(knownHostsPath);
  } catch {
    return;
  }

  const port = config.port ?? 22;
  const hostPatterns = port === 22
    ? [config.host]
    : [config.host, `[${config.host}]:${port}`];

  const knownEntries = new Set<string>();
  for (const pattern of hostPatterns) {
    try {
      const output = await execFileText(
        "ssh-keygen",
        ["-F", pattern, "-f", knownHostsPath],
        4_000,
      );
      for (const entry of parseKnownHostsEntries(output)) {
        knownEntries.add(entry);
      }
    } catch {
      // No matching entry for this host pattern.
    }
  }

  if (knownEntries.size === 0) return;

  let scanned: string;
  try {
    scanned = await execFileText(
      "ssh-keyscan",
      ["-p", String(port), "-T", "5", config.host],
      7_000,
    );
  } catch {
    return;
  }

  const scannedEntries = parseKnownHostsEntries(scanned);
  if (scannedEntries.size === 0) return;

  for (const entry of knownEntries) {
    if (scannedEntries.has(entry)) {
      return;
    }
  }

  for (const pattern of hostPatterns) {
    try {
      await execFileText(
        "ssh-keygen",
        ["-R", pattern, "-f", knownHostsPath],
        4_000,
      );
      systemDebug(
        "ssh-known-hosts",
        `removed stale known_hosts entry for ${pattern}`,
      );
    } catch {
      // Best effort cleanup only.
    }
  }
}

// ─── Local executor ──────────────────────────────────────────────────────────

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
    _options?: { excludes?: string[] },
  ): Promise<void> {
    const log = onLog ?? (() => {});
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

// ─── SSH executor ────────────────────────────────────────────────────────────

/**
 * Runs commands on a remote server via SSH.
 * File operations use SFTP.
 *
 * The SSH connection is established lazily on first use and reused for
 * all subsequent operations. Call `dispose()` to close the connection.
 *
 * Security: supports key, agent, or password auth.
 */
export class SshExecutor implements CommandExecutor {
  private client: import("ssh2").Client | null = null;
  private connecting: Promise<import("ssh2").Client> | null = null;
  private readonly config: SshConfig;

  constructor(config: SshConfig) {
    if (!config.privateKey && !config.sshAgent && !config.password) {
      throw new Error(
        "SSH requires one of privateKey, sshAgent, or password.",
      );
    }
    this.config = config;
  }

  /** Lazily establish the SSH connection. */
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

  /**
   * Pipe a local command's stdout into a remote command via SSH.
   * Used internally by transferIn to stream tar archives.
   */
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
          env: { ...process.env, COPYFILE_DISABLE: "1" },
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

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[] },
  ): Promise<void> {
    const excludes = options?.excludes ?? ["node_modules", ".git"];
    const excludeFlags = excludes.map((e) => `--exclude=${sq(e)}`).join(" ");
    // --no-mac-metadata strips .apple.provenance / xattr headers on macOS;
    // harmless on GNU tar (unknown flag is silently ignored by the piped extraction).
    const macFlags = process.platform === "darwin" ? "--no-mac-metadata " : "";
    const tarCmd = excludeFlags
      ? `tar ${macFlags}czf - -C ${sq(localPath)} ${excludeFlags} .`
      : `tar ${macFlags}czf - -C ${sq(localPath)} .`;
    const { code } = await this.pipeLocal(
      tarCmd,
      `mkdir -p ${sq(remotePath)} && tar xzf - -C ${sq(remotePath)}`,
      onLog,
    );
    if (code !== 0) throw new Error("Failed to transfer files to remote server");
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
