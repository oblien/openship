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
  /** Cached SFTP subsystem channel, reused across writeFile/readFile/exists
   *  (see `sftp()` below — this is the fix for the channel leak in #34). */
  private sftpWrapper: SFTPWrapper | null = null;
  private sftpConnecting: Promise<SFTPWrapper> | null = null;
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
        this.clearSftp();
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
   * Return the cached SFTP subsystem channel, opening ONE on first use and
   * reusing it for every subsequent writeFile/readFile/exists call on this
   * connection. Each `client.sftp()` opens a distinct channel that counts
   * against the server's `MaxSessions`; opening a fresh one per call and
   * never closing it leaked a channel per file op and eventually exhausted
   * MaxSessions, cancelling in-flight deploys (#34). The cache is evicted by
   * `clearSftp()` on channel close/error, `resetConnection()`, or `dispose()`,
   * so a dead channel is transparently reopened on the next call.
   */
  private async sftp(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return this.sftpWrapper;
    if (this.sftpConnecting) return this.sftpConnecting;

    this.sftpConnecting = (async () => {
      const client = await this.connect();
      const wrapper = await openSftp(client);
      const evict = () => {
        if (this.sftpWrapper === wrapper) this.sftpWrapper = null;
      };
      wrapper.on("close", evict);
      wrapper.on("error", evict);
      this.sftpWrapper = wrapper;
      this.sftpConnecting = null;
      return wrapper;
    })();

    return this.sftpConnecting;
  }

  /** Ends the cached SFTP channel (if any) so the next `sftp()` call reopens one. */
  private clearSftp(): void {
    if (this.sftpWrapper) {
      try { this.sftpWrapper.end(); } catch { /* already gone */ }
    }
    this.sftpWrapper = null;
    this.sftpConnecting = null;
  }

  /**
   * Force-close the current connection so the next call reconnects.
   */
  private resetConnection(): void {
    this.clearSftp();
    if (this.client) {
      try { this.client.end(); } catch {}
      this.client = null;
    }
    this.connecting = null;
  }

  /** Returns true if the error is an SSH channel-open failure. */
  private static isChannelError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("channel open failure") || msg.includes("open failed");
  }

  /**
   * A channel-open just failed ("Channel open failure: open failed" — e.g.
   * after the idle timeout half-kills the socket, or the server briefly
   * refuses a new channel under session pressure). Decide how to recover:
   *
   * - If nothing else is running on this connection (`inflight` empty — no
   *   in-progress exec/streamExec), the transport itself is the likely
   *   culprit; force a clean reconnect.
   * - If something else IS in flight — most importantly a `docker build`
   *   streaming over `streamExec` — that channel is proof the transport is
   *   fine; only the NEW channel was refused. Don't `resetConnection()` (=
   *   `client.end()`) in that case: it would tear down every channel on the
   *   connection, cancelling the unrelated build (#34's actual reported
   *   symptom). Just evict the cached SFTP channel (in case that's what's
   *   stale) and retry on the SAME connection.
   */
  private async recoverChannelError(): Promise<void> {
    if (this.inflight.size === 0) {
      this.resetConnection();
    } else {
      this.clearSftp();
    }
  }

  /**
   * Run an operation, and on a channel-open failure recover (see
   * `recoverChannelError`) and retry ONCE. This is why `exec` survives a
   * stale connection; the SFTP-based ops (writeFile/readFile/exists) must go
   * through it too, or a deploy's route write fails spuriously and only
   * succeeds on a manual redeploy.
   */
  private async withChannelRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (SshExecutor.isChannelError(err)) {
        await this.recoverChannelError();
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
            if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
            else resolve(stdout.trim());
          });
        });
      });
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    return this._streamExec(command, onLog).catch(async (err) => {
      if (SshExecutor.isChannelError(err)) {
        await this.recoverChannelError();
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

        stream.on("close", (code: number) => {
          finish(() => resolve({ code: code ?? 1, output: chunks.join("") }));
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
    this.reverseHandlers.clear();
    this.reverseListenerClient = null;
    this.clearSftp();
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[] },
  ): Promise<void> {
    // Pack the tree into ONE archive, upload that single file, verify + extract.
    // Transport: rsync (fast + resumable) when the toolchain allows; otherwise
    // ssh2 SFTP, made stall-proof + resumable on our side.
    const deps = { config: this.config, hasRemoteCommand: (c: string) => this.hasRemoteCommand(c) };
    const excludes = options?.excludes ?? [...TRANSFER_EXCLUDES];
    const { args: tarArgs, cleanup: cleanupTarList } = await prepareSourceTarArgs(localPath, {
      excludes,
      includes: options?.includes,
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