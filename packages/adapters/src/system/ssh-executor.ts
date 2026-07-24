import { createReadStream } from "node:fs";
import { mkdtemp, rm as fsRm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { prepareSourceTarArgs } from "../archive";
import type {
  CommandExecutor,
  LogEntry,
  ShellOptions,
  ShellSession,
  SshConfig,
} from "../types";
import { logEntry, sq } from "./local-shell";
import { canUseRemoteRsync, extractRemoteArchive, packLocalArchive, uploadFileWithRsync } from "./remote-transfer";
import type { Client as SshClient, SFTPWrapper } from "ssh2";
import type { Readable, Duplex } from "node:stream";
import { connectSshClient, openSftp, openSshUnixSocket, type StreamLocalCapableClient } from "./ssh-client";
import { SshDisconnectedError } from "./errors";
import { TRANSFER_EXCLUDES, formatBytes } from "@repo/core";

/** Clamp a window dimension to a sane range to avoid garbage values
 *  reaching ssh2.Client.shell() / channel.setWindow(). */
function clampWindow(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Runs commands on a remote server via SSH.
 * File operations use SFTP.
 */
export class SshExecutor implements CommandExecutor {
  private client: SshClient | null = null;
  private connecting: Promise<SshClient> | null = null;
  /** One shared SFTP subsystem channel per client — see sftp(). */
  private sftpChannel: Promise<SFTPWrapper> | null = null;
  private readonly config: SshConfig;
  /** Subscribers notified when the transport drops (see onDisconnect). */
  private readonly disconnectListeners = new Set<(err: Error) => void>();
  /** In-flight cancelable ops — each entry aborts ONE exec/stream on a drop,
   *  so a dead channel fails fast instead of hanging to its command timeout. */
  private readonly inflight = new Set<(err: Error) => void>();
  /** Reverse-forward handlers keyed by the remote bound port (see reverseForward). */
  private readonly reverseHandlers = new Map<number, (stream: Duplex) => void>();
  /** The client the single 'tcp connection' dispatcher is attached to (re-attached on reconnect). */
  private reverseListenerClient: SshClient | null = null;

  constructor(config: SshConfig) {
    if (!config.privateKey && !config.sshAgent && !config.password) {
      throw new Error("SSH requires one of privateKey, sshAgent, or password.");
    }
    this.config = config;
  }

  private async connect(): Promise<SshClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = await connectSshClient(this.config);

      const onTransportDown = (cause?: Error) => {
        if (this.client !== client) return; // superseded / already handled
        this.client = null;
        this.sftpChannel = null; // channel died with the client
        this.handleDisconnect(cause);
      };

      client.on("close", () => onTransportDown());
      client.on("end", () => onTransportDown());
      client.on("error", (err: Error) => onTransportDown(err));

      this.client = client;
      this.connecting = null;
      return client;
    })();

    return this.connecting;
  }

  /**
   * Subscribe to transport-level disconnects. Returns an unsubscribe fn.
   */
  onDisconnect(cb: (err: Error) => void): () => void {
    this.disconnectListeners.add(cb);
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  /**
   * The transport died. Reject every in-flight exec/stream with a typed
   * SshDisconnectedError — so they fail in <1s instead of hanging to their
   * per-command timeout on a dead channel — then notify subscribers so the
   * manager can reconnect / re-drive journaled ops.
   */
  private handleDisconnect(cause?: Error): void {
    const err = new SshDisconnectedError(
      cause?.message ? `SSH connection lost: ${cause.message}` : "SSH connection lost",
    );
    const aborts = [...this.inflight];
    this.inflight.clear();
    for (const abort of aborts) {
      try { abort(err); } catch { /* per-op settle guard handles double-settle */ }
    }
    for (const cb of [...this.disconnectListeners]) {
      try { cb(err); } catch { /* a listener bug must not break disconnect handling */ }
    }
  }

  /**
   * One SFTP subsystem channel per client, opened lazily and shared by every
   * file op. ssh2's SFTPWrapper pipelines many concurrent requests over a
   * single channel, so file operations cost exactly ONE session against the
   * server's MaxSessions — not one channel per op, which leaks and exhausts
   * the quota, then takes down the whole connection (incl. a live build) on
   * the next channel-open failure (#34). Self-clears on the channel's own
   * close/error and on resetConnection/dispose so the next op reopens clean.
   */
  private async sftp(): Promise<SFTPWrapper> {
    const client = await this.connect();
    if (this.sftpChannel) return this.sftpChannel;

    const opening = openSftp(client).then((wrapper) => {
      const drop = () => {
        if (this.sftpChannel === opening) this.sftpChannel = null;
      };
      wrapper.once("close", drop);
      wrapper.once("error", drop);
      return wrapper;
    });
    opening.catch(() => {
      if (this.sftpChannel === opening) this.sftpChannel = null;
    });
    this.sftpChannel = opening;
    return opening;
  }

  /** Close + forget the shared SFTP channel (frees its session) without
   *  touching the SSH client, so file ops can reopen on the same connection. */
  private dropSftp(): void {
    const ch = this.sftpChannel;
    this.sftpChannel = null;
    if (ch) ch.then((w) => { try { w.end(); } catch {} }).catch(() => {});
  }

  /**
   * Force-close the current connection so the next call reconnects.
   */
  private resetConnection(): void {
    this.dropSftp();
    if (this.client) {
      try { this.client.end(); } catch {}
      this.client = null;
    }
    this.connecting = null;
  }

  /**
   * Recover from a channel-open failure without killing live work. If other
   * ops are still streaming on this connection (a docker build, an exec), the
   * failure is session pressure — NOT a dead socket — so ending the client
   * would abort that in-flight command (#34). Free the SFTP channel and keep
   * the connection. With nothing in flight the cached socket is stale (idle
   * drop), so reset it fully.
   */
  private recoverFromChannelError(): void {
    if (this.inflight.size > 0) this.dropSftp();
    else this.resetConnection();
  }

  /** Returns true if the error is an SSH channel-open failure. */
  private static isChannelError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("channel open failure") || msg.includes("open failed");
  }

  /**
   * Run an operation, and if it fails opening an SSH channel on a half-dead
   * cached connection ("Channel open failure: open failed" — common after the
   * idle timeout drops the socket), drop the connection and retry ONCE on a
   * fresh one. This is why `exec` survives a stale connection; the SFTP-based
   * ops (writeFile/readFile/exists) must go through it too, or a deploy's route
   * write fails spuriously and only succeeds on a manual redeploy.
   */
  private async withChannelRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (SshExecutor.isChannelError(err)) {
        this.recoverFromChannelError();
        return fn();
      }
      throw err;
    }
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    return this.withChannelRetry(() => this._exec(command, opts));
  }

  /** Prefix applied to every SSH command - keeps dpkg non-interactive. */
  private static readonly ENV_PREFIX =
    'export DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew && ';

  private async _exec(command: string, opts?: { timeout?: number }): Promise<string> {
    const client = await this.connect();
    const timeout = opts?.timeout ?? 30_000;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      // `abort` cancels THIS op on a transport drop; `finish` is the single
      // settle path (guards double-settle, clears the timer, deregisters).
      const abort = (err: Error) => finish(() => reject(err));
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.inflight.delete(abort);
        act();
      };
      this.inflight.add(abort);

      timer = setTimeout(
        () => finish(() => reject(new Error(`Command timed out after ${timeout}ms: ${command}`))),
        timeout,
      );

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return finish(() => reject(err));

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          finish(() => {
            if (code !== 0) {
              // Include stdout too — certbot & friends write the real error there
              // while stderr only has boilerplate, so stderr-only hid the cause.
              const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
              reject(new Error(detail || `Exit code ${code}`));
            } else resolve(stdout.trim());
          });
        });
      });
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    return this._streamExec(command, onLog).catch((err) => {
      if (SshExecutor.isChannelError(err)) {
        this.recoverFromChannelError();
        return this._streamExec(command, onLog);
      }
      throw err;
    });
  }

  private async _streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    const client = await this.connect();

    return new Promise<{ code: number; output: string }>((resolve, reject) => {
      let settled = false;

      // A transport drop mid-stream rejects with SshDisconnectedError instead
      // of silently resolving `code ?? 1` (truncated output). Callers treat the
      // throw as a real failure; the manager can reconnect/re-drive.
      const abort = (err: Error) => finish(() => reject(err));
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        this.inflight.delete(abort);
        act();
      };
      this.inflight.add(abort);

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return finish(() => reject(err));

        // Raw passthrough (see LocalExecutor.streamExec): forward the untouched
        // byte stream as rawData so the client's xterm renders "\r"/ANSI
        // natively — progress lines repaint in place instead of new lines.
        const chunks: string[] = [];

        const onChunk = (data: Buffer, level: LogEntry["level"]) => {
          const text = data.toString();
          if (!text) return;
          chunks.push(text);
          onLog(logEntry(text, level, data.toString("base64")));
        };

        stream.on("data", (data: Buffer) => onChunk(data, "info"));
        stream.stderr.on("data", (data: Buffer) => onChunk(data, "warn"));

        // ssh2's 'close' often carries no code; the real exit status arrives on
        // 'exit'. A close with NO exit status means the channel was torn down
        // under the command (connection reset / session exhaustion), not a real
        // exit — surface that instead of masking it as a generic exit code 1 (#34).
        let exitCode: number | null = null;
        stream.on("exit", (code: number | null) => { exitCode = code; });
        stream.on("close", (code: number | null) => {
          finish(() => {
            const final = typeof code === "number" ? code : exitCode;
            if (final == null) {
              reject(
                new Error(
                  "remote channel closed without an exit status — the SSH connection or channel was terminated mid-command",
                ),
              );
            } else {
              resolve({ code: final, output: chunks.join("") });
            }
          });
        });
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = dirname(path);
    try {
      await this.exec(`mkdir -p ${sq(dir)}`);
    } catch {
      // Best effort
    }

    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      return new Promise<void>((resolve, reject) => {
        sftp.writeFile(path, content, { encoding: "utf-8" }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async readFile(path: string): Promise<string> {
    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      return new Promise<string>((resolve, reject) => {
        sftp.readFile(path, { encoding: "utf-8" }, (err, data) => {
          if (err) reject(err);
          else resolve(data.toString());
        });
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      return new Promise<boolean>((resolve) => {
        sftp.stat(path, (err) => {
          resolve(!err);
        });
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

  rawExec(command: string): Promise<{
    stdout: Readable;
    stderr: Readable;
    onClose: Promise<number>;
    kill: () => void;
  }> {
    return (async () => {
      const client = await this.connect();
      return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err);
          const onClose = new Promise<number>((res) => {
            stream.on("close", (code: number) => res(code ?? 1));
          });
          resolve({
            stdout: stream,
            stderr: stream.stderr,
            onClose,
            kill: () => { try { stream.close(); } catch {} },
          });
        });
      });
    })();
  }

  /**
   * Open an interactive PTY shell on the remote host. The returned
   * ShellSession wraps an ssh2 ClientChannel: writes go to stdin,
   * stdout/stderr emit on the readable streams, setWindow forwards to
   * channel.setWindow, close ends the channel. Lifetime is bound to the
   * channel - the underlying ssh2.Client stays cached by sshManager, so
   * callers must wrap with `sshManager.retain(serverId)` / `release()`
   * to avoid the 5-minute idle drop on the parent connection.
   */
  async openShell(opts?: ShellOptions): Promise<ShellSession> {
    const client = await this.connect();
    const cols = clampWindow(opts?.cols, 80, 1, 1000);
    const rows = clampWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    const channel = await new Promise<import("ssh2").ClientChannel>(
      (resolve, reject) => {
        client.shell(
          { term, cols, rows, width: 0, height: 0, modes: {} },
          (err, ch) => (err ? reject(err) : resolve(ch)),
        );
      },
    );

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try { cb(code, signal); } catch { /* listener bug shouldn't kill cleanup */ }
      }
    };

    // ssh2 emits 'exit' with the remote exit code (or signal), then
    // 'close' once the channel teardown finishes. We fire on whichever
    // arrives first and de-dup via the `closed` flag.
    channel.on("exit", (code: number | null, signal?: string) => {
      fireClose(code, signal);
    });
    channel.on("close", () => fireClose(null));
    channel.on("error", () => fireClose(null));

    return {
      stdin: channel,
      stdout: channel,
      stderr: channel.stderr,
      setWindow: (c: number, r: number) => {
        const sc = clampWindow(c, 80, 1, 1000);
        const sr = clampWindow(r, 24, 1, 500);
        try { channel.setWindow(sr, sc, 0, 0); } catch { /* channel may be closing */ }
      },
      close: (_signal?: string) => {
        try { channel.end(); } catch { /* already ending */ }
        try { channel.close(); } catch { /* already closed */ }
      },
      onClose: (cb) => { closeListeners.push(cb); },
    };
  }

  async forwardUnixSocket(socketPath: string): Promise<Duplex> {
    const client = await this.connect();
    return openSshUnixSocket(client as StreamLocalCapableClient, socketPath);
  }

  async forwardPort(remoteHost: string, remotePort: number): Promise<Duplex> {
    const client = await this.connect();
    return new Promise<Duplex>((resolve, reject) => {
      client.forwardOut(
        "127.0.0.1", 0,
        remoteHost, remotePort,
        (err, stream) => {
          if (err) return reject(err);
          resolve(stream as unknown as Duplex);
        },
      );
    });
  }

  /**
   * Open a reverse tunnel: the remote listens on an ephemeral 127.0.0.1 port
   * and every connection to it is handed to `onConnection` as a duplex stream
   * over this SSH connection. ssh2's 'tcp connection' event is client-wide, so
   * a single dispatcher routes by the bound `destPort` to the right handler.
   */
  async reverseForward(
    onConnection: (stream: Duplex) => void,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const client = await this.connect();
    this.attachReverseListener(client);

    const port = await new Promise<number>((resolve, reject) => {
      client.forwardIn("127.0.0.1", 0, (err, boundPort) => {
        if (err) return reject(err);
        resolve(boundPort);
      });
    });
    this.reverseHandlers.set(port, onConnection);

    return {
      port,
      close: async () => {
        this.reverseHandlers.delete(port);
        await new Promise<void>((resolve) => {
          try {
            client.unforwardIn("127.0.0.1", port, () => resolve());
          } catch {
            resolve();
          }
        });
      },
    };
  }

  /** Attach the single client-wide 'tcp connection' dispatcher (idempotent per client). */
  private attachReverseListener(client: SshClient): void {
    if (this.reverseListenerClient === client) return;
    this.reverseListenerClient = client;
    client.on("tcp connection", (details, accept, reject) => {
      const handler = this.reverseHandlers.get(details.destPort);
      if (!handler) {
        // No relay registered on this port — refuse rather than leak a channel.
        try { reject(); } catch { /* already gone */ }
        return;
      }
      const channel = accept();
      handler(channel as unknown as Duplex);
    });
  }

  async dispose(): Promise<void> {
    this.connecting = null;
    this.sftpChannel = null;
    this.reverseHandlers.clear();
    this.reverseListenerClient = null;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[]; alsoInclude?: string[] },
  ): Promise<void> {
    // Pack the tree into ONE archive, upload that single file, verify + extract.
    // Transport: rsync (fast + resumable) when the toolchain allows; otherwise
    // ssh2 SFTP, made stall-proof + resumable on our side.
    const deps = { config: this.config, hasRemoteCommand: (c: string) => this.hasRemoteCommand(c) };
    const excludes = options?.excludes ?? [...TRANSFER_EXCLUDES];
    const { args: tarArgs, cleanup: cleanupTarList } = await prepareSourceTarArgs(localPath, {
      excludes,
      includes: options?.includes,
      alsoInclude: options?.alsoInclude,
    });
    const tmpLocalDir = await mkdtemp(join(tmpdir(), "openship-xfer-"));
    const localArchive = join(tmpLocalDir, "context.tar.gz");
    // Sibling of the destination dir so it lands on the same filesystem.
    const remoteArchive = `${remotePath}.openship-xfer.tar.gz`;

    try {
      onLog?.(logEntry("Packing source into a single archive..."));
      await packLocalArchive(tarArgs, localArchive);
      const totalBytes = (await stat(localArchive)).size;
      await this.exec(`mkdir -p ${sq(dirname(remoteArchive))}`);

      const rsync = await canUseRemoteRsync(deps);
      if (rsync.ok) {
        onLog?.(logEntry(`Uploading ${formatBytes(totalBytes)} archive via rsync (resumable)...`));
        await uploadFileWithRsync(localArchive, remoteArchive, deps, onLog);
      } else {
        onLog?.(
          logEntry(`Uploading ${formatBytes(totalBytes)} archive via SFTP (resumable) — ${rsync.reason}.`),
        );
        await this.sftpUploadResumable(localArchive, remoteArchive, totalBytes, onLog);
      }

      await extractRemoteArchive((command) => this.exec(command), remoteArchive, remotePath, totalBytes, onLog);
    } finally {
      await cleanupTarList().catch(() => {});
      await fsRm(tmpLocalDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async hasRemoteCommand(command: string): Promise<boolean> {
    try {
      await this.exec(`command -v ${command} >/dev/null 2>&1 && echo ok`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resumable SFTP upload (the fallback when rsync isn't available — password
   * auth with no `sshpass`). Each attempt `stat`s the remote to learn how much
   * already landed and streams the REST from that offset (append), so a dropped
   * or stalled connection continues instead of restarting from 0. A watchdog
   * aborts the attempt if no bytes flow for `STALL_MS`, and the loop retries
   * (resuming) up to `MAX_ATTEMPTS`.
   */
  private async sftpUploadResumable(
    localArchive: string,
    remoteArchive: string,
    totalBytes: number,
    onLog?: (log: LogEntry) => void,
  ): Promise<void> {
    const MAX_ATTEMPTS = 4;
    const STALL_MS = 30_000;
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const sftp = await this.sftp();

      // Resume point = bytes already on the remote from a prior attempt.
      let offset = 0;
      try {
        const size = await new Promise<number>((resolve, reject) =>
          sftp.stat(remoteArchive, (err, stats) => (err ? reject(err) : resolve(stats.size))),
        );
        if (size === totalBytes) return; // already fully uploaded
        if (size < totalBytes) offset = size; // resume from here (size > total → restart at 0)
      } catch {
        offset = 0; // no remote file yet
      }

      if (attempt > 1 || offset > 0) {
        onLog?.(
          logEntry(
            `Resuming SFTP upload from ${formatBytes(offset)} (attempt ${attempt}/${MAX_ATTEMPTS})...`,
            "warn",
          ),
        );
      }

      try {
        await this.sftpStreamFrom(sftp, localArchive, remoteArchive, offset, totalBytes, STALL_MS, onLog);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        onLog?.(logEntry(`SFTP upload interrupted: ${lastErr.message}`, "warn"));
      }
    }

    throw lastErr ?? new Error("SFTP upload failed");
  }

  /** Stream `localArchive` (from `offset`) into `remoteArchive`, appending when
   *  resuming. Rejects on error, on a stall (no bytes for `stallMs`), or if the
   *  stream closes before `totalBytes` land. */
  private sftpStreamFrom(
    sftp: SFTPWrapper,
    localArchive: string,
    remoteArchive: string,
    offset: number,
    totalBytes: number,
    stallMs: number,
    onLog?: (log: LogEntry) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const read = createReadStream(localArchive, { start: offset });
      const write = sftp.createWriteStream(remoteArchive, { flags: offset > 0 ? "a" : "w" });
      let transferred = offset;
      let lastProgressAt = Date.now();
      const startedAt = Date.now();
      let lastReportedAt = startedAt;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        fn();
      };

      const watch = setInterval(() => {
        if (Date.now() - lastProgressAt > stallMs) {
          read.destroy();
          write.end();
          finish(() => reject(new Error(`stalled — no data for ${Math.round(stallMs / 1000)}s`)));
        }
      }, 5_000);
      (watch as { unref?: () => void }).unref?.();

      read.on("data", (chunk: string | Buffer) => {
        transferred += chunk.length;
        lastProgressAt = Date.now();
        const now = Date.now();
        if (now - lastReportedAt >= 2500) {
          lastReportedAt = now;
          const elapsed = (now - startedAt) / 1000;
          const mbps = elapsed > 0 ? (transferred - offset) / 1024 / 1024 / elapsed : 0;
          const pct = totalBytes > 0 ? Math.min(Math.floor((transferred / totalBytes) * 100), 100) : 0;
          onLog?.(logEntry(`  ~${pct}% · ${formatBytes(transferred)} · ${mbps.toFixed(1)} MB/s`));
        }
      });
      read.on("error", (e) => finish(() => reject(e)));
      write.on("error", (e: Error) => finish(() => reject(e)));
      write.on("close", () =>
        finish(() =>
          transferred >= totalBytes
            ? resolve()
            : reject(new Error(`incomplete upload: ${transferred}/${totalBytes} bytes`)),
        ),
      );
      read.pipe(write);
    });
  }
}