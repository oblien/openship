import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatBytes } from "@repo/core";
import { getTarCreateEnv } from "../archive";
import type { LogEntry, SshConfig } from "../types";
import {
  emitBufferedLines,
  flushBufferedLines,
  hasLocalCommand,
  logEntry,
  sq,
} from "./local-shell";
import { reconcileKnownHosts } from "./ssh-support";

/**
 * Shared helpers for the single-archive source transfer: pack the tree into ONE
 * file locally, then upload that one file to the remote and extract it there.
 *
 * The upload has two transports, chosen by capability:
 *   - rsync (fast, resumable) over the OpenSSH binary — the default when the
 *     toolchain is present (key auth via a temp key, agent auth via `-A`, or
 *     password auth when `sshpass` exists). Uses `--partial --inplace
 *     --append-verify --timeout` + a retry loop: a dropped/stalled transfer
 *     RESUMES from the partial (verified by checksum), it never restarts from 0.
 *   - ssh2 SFTP (in-process) — the fallback for password auth without `sshpass`;
 *     the executor makes it stall-proof + resumable on its side.
 */

type LogCallback = (log: LogEntry) => void;

/**
 * Run `tar` locally, streaming its archive to `outFile`. Resolves when tar
 * exits 0 AND the file is fully flushed; rejects with tar's stderr otherwise.
 */
export function packLocalArchive(tarArgs: string[], outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getTarCreateEnv(),
    });
    const out = createWriteStream(outFile);
    let stderr = "";
    let tarCode: number | null = null;
    let tarClosed = false;
    let outClosed = false;
    const settle = () => {
      if (!tarClosed || !outClosed) return;
      if (tarCode === 0) resolve();
      else
        reject(
          new Error(
            `tar failed (exit ${tarCode})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`,
          ),
        );
    };
    tar.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    tar.on("error", reject);
    out.on("error", reject);
    tar.stdout.pipe(out);
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      tarClosed = true;
      settle();
    });
    out.on("finish", () => {
      outClosed = true;
      settle();
    });
  });
}

/**
 * Finish a single-file transfer on the remote: verify the uploaded archive is
 * exactly the size we sent (catches a silently-truncated stream that still
 * exited 0), extract it, and ALWAYS remove the archive afterward — even if tar
 * fails, so a corrupt upload never litters the server. Throws on size mismatch
 * or a non-zero tar, propagating tar's exit code.
 *
 * `exec` runs a command on the remote and resolves with its stdout (rejecting on
 * non-zero exit) — i.e. the executor's own `exec`.
 */
export async function extractRemoteArchive(
  exec: (command: string) => Promise<string>,
  remoteArchive: string,
  remotePath: string,
  expectedBytes: number,
  onLog?: LogCallback,
): Promise<void> {
  const received = Number((await exec(`wc -c < ${sq(remoteArchive)}`)).trim());
  if (received !== expectedBytes) {
    await exec(`rm -f ${sq(remoteArchive)}`).catch(() => {});
    throw new Error(`upload truncated: sent ${expectedBytes} bytes, server received ${received}`);
  }
  await exec(
    `mkdir -p ${sq(remotePath)} && tar xzf ${sq(remoteArchive)} -C ${sq(remotePath)}; rc=$?; rm -f ${sq(remoteArchive)}; exit $rc`,
  );
  onLog?.(logEntry(`Transferred ${formatBytes(expectedBytes)} and extracted on the server.`));
}

// ─── rsync single-file upload (fast + resumable) ────────────────────────────

export interface RsyncDeps {
  config: SshConfig;
  hasRemoteCommand(command: string): Promise<boolean>;
}

/**
 * Make text key material acceptable to the OpenSSH binary used by rsync.
 *
 * ssh2 accepts an OpenSSH private key without a final line feed, while the
 * OpenSSH client rejects that exact file as "invalid format". Pasted keys also
 * commonly arrive with Windows line endings. Keep the credential as stored, but
 * normalize the short-lived file we hand to `ssh -i`.
 */
export function formatPrivateKeyForOpenSsh(privateKey: string): string {
  const normalized = privateKey.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

/**
 * Whether the fast rsync transport is usable for this connection. rsync runs the
 * REAL OpenSSH client (10-30 MB/s vs ssh2's ~0.5-1), so we prefer it — but it
 * needs the local rsync+ssh binaries, the remote rsync binary, and (password
 * auth only) `sshpass` to feed the password non-interactively.
 */
export async function canUseRemoteRsync(
  deps: RsyncDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (deps.config.privateKey && deps.config.privateKeyPassphrase && !deps.config.sshAgent) {
    return {
      ok: false,
      reason: "encrypted SSH keys without an agent are not supported by non-interactive rsync",
    };
  }

  const [localRsync, localSsh, localSshpass, remoteRsync] = await Promise.all([
    hasLocalCommand("rsync"),
    hasLocalCommand("ssh"),
    deps.config.password ? hasLocalCommand("sshpass") : Promise.resolve(true),
    deps.hasRemoteCommand("rsync"),
  ]);

  if (!localRsync) return { ok: false, reason: "local rsync is not installed" };
  if (!localSsh) return { ok: false, reason: "local ssh is not installed" };
  if (!localSshpass)
    return { ok: false, reason: "local sshpass is not installed for password-based rsync" };
  if (!remoteRsync) return { ok: false, reason: "remote rsync is not installed" };

  return { ok: true };
}

/** Build the `-e` transport command rsync uses (ssh, or sshpass+ssh for password
 *  auth). Password is passed via the SSHPASS env var (set in runRsync), never in
 *  argv. */
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

/** Materialize config.privateKey to a temp file (0600) for rsync's `-i`, clean up
 *  after. No-op (calls fn without a key) for agent or password auth. */
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
    await fsWriteFile(keyPath, formatPrivateKeyForOpenSsh(config.privateKey), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    return await fn(keyPath);
  } finally {
    await fsRm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Spawn rsync, stream its progress lines to onLog, resolve with the exit code. */
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

/**
 * Upload a SINGLE local file to a remote path with rsync over the OpenSSH binary
 * — fast, and RESUMABLE. `--partial` keeps the partially-transferred file at the
 * destination on interruption; on the next attempt rsync's delta algorithm reads
 * that partial and sends only the missing tail (checksum/hash-based resume, and
 * version-agnostic — it works on the ancient rsync 2.6.9 macOS ships, unlike the
 * 3.0-only `--append-verify`/`--inplace`). `--timeout=60` aborts a stalled
 * transfer (no I/O for 60s) instead of hanging. The retry loop re-invokes rsync
 * on any non-zero exit; each attempt continues from the partial, never from 0.
 */
export async function uploadFileWithRsync(
  localFile: string,
  remoteFile: string,
  deps: RsyncDeps,
  onLog?: LogCallback,
  opts?: { retries?: number },
): Promise<void> {
  await reconcileKnownHosts(deps.config);
  const retries = Math.max(1, opts?.retries ?? 3);
  const host = deps.config.host.includes(":") ? `[${deps.config.host}]` : deps.config.host;
  const user = deps.config.username ?? "root";
  // The path is a single rsync argv element (runRsync spawns rsync directly, no
  // shell), so it must NOT be shell-quoted. rsync 3.2.4+ defaults to
  // protected-args and sends the arg to the remote WITHOUT shell splitting —
  // wrapping it in `sq()` would send literal quotes, breaking as
  // `change_dir "/root/'/tmp…"`. openship remote paths are generated (no spaces/
  // metachars), so the raw path is correct on both modern and legacy rsync.
  const target = `${user}@${host}:${remoteFile}`;

  await withTemporaryPrivateKey(deps.config, async (keyPath) => {
    let lastCode = 1;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (attempt > 1) {
        onLog?.(
          logEntry(
            `Connection dropped — resuming upload (attempt ${attempt}/${retries})...`,
            "warn",
          ),
        );
      }
      const args = [
        "-a", // already gzipped, so no `-z`
        "--partial", // keep the partial on interruption; delta-resume on re-run
        "--progress",
        "--timeout=60", // abort if no I/O for 60s → surfaces a stall as a retryable exit
        "-e",
        buildRsyncSshCommand(deps.config, keyPath),
        localFile,
        target,
      ];
      const { code } = await runRsync(deps.config, args, onLog);
      if (code === 0) return;
      lastCode = code;
    }
    throw new Error(`rsync upload failed after ${retries} attempt(s) (exit ${lastCode})`);
  });
}
