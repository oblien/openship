import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSFER_EXCLUDES } from "@repo/core";
import { getTarCreateArgs, getTarCreateEnv } from "../archive";
import type { LogEntry, SshConfig } from "../types";
import {
  emitBufferedLines,
  flushBufferedLines,
  hasLocalCommand,
  logEntry,
  sq,
} from "./local-shell";
import { reconcileKnownHosts } from "./ssh-support";

type TransferOptions = { excludes?: string[]; includes?: string[] };
type LogCallback = (log: LogEntry) => void;

export interface RemoteTransferDeps {
  config: SshConfig;
  hasRemoteCommand(command: string): Promise<boolean>;
  ensureRemoteDir(path: string): Promise<void>;
  pipeLocal(
    localCmd: string,
    remoteCmd: string,
    onLog?: LogCallback,
  ): Promise<{ code: number }>;
}

export async function canUseRemoteRsync(
  deps: RemoteTransferDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (deps.config.privateKey && deps.config.privateKeyPassphrase && !deps.config.sshAgent) {
    return { ok: false, reason: "encrypted SSH keys without an agent are not supported by non-interactive rsync" };
  }

  const [localRsync, localSsh, localSshpass, remoteRsync] = await Promise.all([
    hasLocalCommand("rsync"),
    hasLocalCommand("ssh"),
    deps.config.password ? hasLocalCommand("sshpass") : Promise.resolve(true),
    deps.hasRemoteCommand("rsync"),
  ]);

  if (!localRsync) {
    return { ok: false, reason: "local rsync is not installed" };
  }

  if (!localSsh) {
    return { ok: false, reason: "local ssh is not installed" };
  }

  if (!localSshpass) {
    return { ok: false, reason: "local sshpass is not installed for password-based rsync" };
  }

  if (!remoteRsync) {
    return { ok: false, reason: "remote rsync is not installed" };
  }

  return { ok: true };
}

export async function transferRemoteDirectoryWithRsync(
  localPath: string,
  remotePath: string,
  deps: RemoteTransferDeps,
  onLog?: LogCallback,
  options?: TransferOptions,
): Promise<void> {
  await reconcileKnownHosts(deps.config);
  await deps.ensureRemoteDir(remotePath);

  await withTemporaryPrivateKey(deps.config, async (keyPath) => {
    const args = [
      "-az",
      "--partial",
      "--progress",
      "--stats",
      "-e",
      buildRsyncSshCommand(deps.config, keyPath),
    ];

    const target = formatRsyncTarget(deps.config, remotePath);

    if (options?.includes?.length) {
      args.push(...options.includes, target);
      onLog?.(logEntry(`Using rsync with live progress (${options.includes.length} selected paths)...`));
      const { code } = await runRsync(deps.config, args, onLog, localPath);
      if (code !== 0) {
        throw new Error("rsync transfer failed");
      }
      return;
    }

    for (const exclude of options?.excludes ?? [...TRANSFER_EXCLUDES]) {
      args.push("--exclude", exclude);
    }

    args.push(`${localPath}/`, target);
    onLog?.(logEntry("Using rsync with live progress for remote transfer..."));

    const { code } = await runRsync(deps.config, args, onLog);
    if (code !== 0) {
      throw new Error("rsync transfer failed");
    }
  });
}

export async function transferRemoteDirectoryWithTar(
  localPath: string,
  remotePath: string,
  deps: RemoteTransferDeps,
  onLog?: LogCallback,
  options?: TransferOptions,
): Promise<void> {
  const tarArgs = getTarCreateArgs(localPath, {
    excludes: options?.excludes ?? [...TRANSFER_EXCLUDES],
    includes: options?.includes,
  });
  const tarCmd = `tar ${tarArgs.map(sq).join(" ")}`;

  const { code } = await deps.pipeLocal(
    tarCmd,
    `mkdir -p ${sq(remotePath)} && tar xzf - -C ${sq(remotePath)}`,
    onLog,
  );
  if (code !== 0) {
    throw new Error("Failed to transfer files to remote server");
  }
}

function formatRsyncTarget(config: SshConfig, remotePath: string): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const user = config.username ?? "root";
  const normalized = remotePath.endsWith("/") ? remotePath : `${remotePath}/`;
  return `${user}@${host}:${sq(normalized)}`;
}

function buildRsyncSshCommand(config: SshConfig, keyPath?: string): string {
  const args = config.password
    ? [
        "sshpass",
        "-e",
        "ssh",
        "-p",
        String(config.port ?? 22),
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "StrictHostKeyChecking=accept-new",
      ]
    : [
        "ssh",
        "-p",
        String(config.port ?? 22),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
      ];

  if (config.sshAgent) {
    args.push("-A");
  }

  if (keyPath) {
    args.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
  }

  return args.map(sq).join(" ");
}

async function withTemporaryPrivateKey<T>(
  config: SshConfig,
  fn: (keyPath?: string) => Promise<T>,
): Promise<T> {
  if (!config.privateKey || config.sshAgent) {
    return fn();
  }

  const tempDir = await mkdtemp(join(tmpdir(), "openship-rsync-key-"));
  const keyPath = join(tempDir, "id_rsa");

  try {
    await fsWriteFile(keyPath, config.privateKey);
    await chmod(keyPath, 0o600);
    return await fn(keyPath);
  } finally {
    await fsRm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runRsync(
  config: SshConfig,
  args: string[],
  onLog?: LogCallback,
  cwd?: string,
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("rsync", args, {
      cwd,
      env: {
        ...getTarCreateEnv(),
        ...(config.password ? { SSHPASS: config.password } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutState = { partial: "" };
    const stderrState = { partial: "" };

    proc.stdout.on("data", (chunk: Buffer) => {
      emitBufferedLines(chunk, stdoutState, (line) => onLog?.(logEntry(line)));
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      emitBufferedLines(chunk, stderrState, (line) => onLog?.(logEntry(line)));
    });

    proc.on("error", (err) => {
      reject(new Error(`rsync failed to start: ${err.message}`));
    });

    proc.on("close", (code) => {
      flushBufferedLines(stdoutState, (line) => onLog?.(logEntry(line)));
      flushBufferedLines(stderrState, (line) => onLog?.(logEntry(line)));
      resolve({ code: code ?? 1 });
    });
  });
}