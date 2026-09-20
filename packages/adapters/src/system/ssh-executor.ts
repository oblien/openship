import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream } from "node:fs";
import { mkdtemp, rm as fsRm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { prepareSourceTarArgs } from "../archive";
import type { CommandExecutor, LogEntry, ShellOptions, ShellSession, SshConfig } from "../types";
import { logEntry, sq } from "./local-shell";
import {
  canUseRemoteRsync,
  extractRemoteArchive,
  packLocalArchive,
  uploadFileWithRsync,
} from "./remote-transfer";
import type { Client as SshClient, ClientChannel, SFTPWrapper } from "ssh2";
import type { Readable, Duplex } from "node:stream";
import {
  connectSshClient,
  openSftp,
  openSshUnixSocket,
  openDockerDialStdioChannel,
  type StreamLocalCapableClient,
} from "./ssh-client";
import {
  commandForError,
  isSshExecRequestError,
  SshDisconnectedError,
  SshExecRequestError,
} from "./errors";
import { TRANSFER_EXCLUDES, formatBytes } from "@repo/core";

/**
 * `dirname` for a path on the TARGET box, which is Linux — so always POSIX,
 * never the control plane's native separators. A backslash reaching SSH is an
 * ordinary filename character there: the file lands in the login shell's cwd
 * under that literal name instead of the directory it was meant to name.
 *
 * The plain `join` above is the other namespace — LOCAL staging paths under
 * tmpdir, where native separators are correct.
 */
const remoteDirname = posix.dirname;

/** File operations are small control-plane payloads (state, vhosts, app
 * config), not bulk transfers.  No ssh2 callback may own a deployment lock
 * forever if the channel loses a reply. */
const SFTP_OPERATION_TIMEOUT_MS = 30_000;
/** Give ssh2 a short graceful-close window before destroying the transport.
 * Destruction is the bounded fallback that guarantees the remote SFTP process
 * can no longer receive mutations before the deployment lock is released. */
const CHANNEL_CLOSE_GRACE_MS = 750;
const TRANSPORT_CLOSE_GRACE_MS = 250;

/**
 * ssh2 exposes SSH_MSG_CHANNEL_FAILURE for an exec request as one untyped
 * sentinel. Tag it while we still know the error came from `Client.exec`'s
 * pre-stream callback; matching later would confuse remote command stderr with
 * a command that never started.
 */
function tagExecRequestError(error: Error): Error {
  return error.message === "Unable to exec" ? new SshExecRequestError(error) : error;
}

function abortError(operation: string, signal: AbortSignal): Error {
  const reason = signal.reason;
  const suffix = reason instanceof Error && reason.message ? `: ${reason.message}` : "";
  const error = new Error(`SSH ${operation} cancelled${suffix}`);
  error.name = "AbortError";
  return error;
}

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
  private sftpWrapper: SFTPWrapper | null = null;
  /** All requests cancelled on one shared channel join the same close/reset
   * barrier, so the second listener cannot miss the first listener's `close`
   * event and needlessly wait for the force-reset deadline. */
  private readonly sftpQuiescence = new WeakMap<SFTPWrapper, Promise<void>>();
  private readonly config: SshConfig;
  /** Deployment cancellation belongs to an async call tree, not to this pooled
   * executor instance.  AsyncLocalStorage prevents one deployment from making
   * unrelated users of the same SSH connection inherit its signal. */
  private readonly abortScope = new AsyncLocalStorage<AbortSignal>();
  /** Subscribers notified when the transport drops (see onDisconnect). */
  private readonly disconnectListeners = new Set<(err: Error) => void>();
  /** In-flight cancelable ops — each entry aborts ONE exec/stream/SFTP request on a drop,
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

  runWithAbortSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError("operation", signal));
    return this.abortScope.run(signal, async () => {
      this.throwIfAborted("operation");
      return fn();
    });
  }

  private operationSignal(): AbortSignal | undefined {
    return this.abortScope.getStore();
  }

  private throwIfAborted(operation: string, signal = this.operationSignal()): void {
    if (signal?.aborted) throw abortError(operation, signal);
  }

  private resolvedSignal(explicit?: AbortSignal): AbortSignal | undefined {
    const ambient = this.operationSignal();
    if (!explicit || explicit === ambient) return ambient ?? explicit;
    if (!ambient) return explicit;
    return AbortSignal.any([explicit, ambient]);
  }

  /** A handshake is already bounded by ssh2's readyTimeout.  A deployment
   * cancellation may stop waiting sooner because no remote mutation can have
   * started before connect() resolves; the shared attempt is left alive for an
   * unrelated/following caller instead of tearing down pooled state. */
  private awaitConnection(attempt: Promise<SshClient>): Promise<SshClient> {
    const signal = this.operationSignal();
    if (!signal) return attempt;
    this.throwIfAborted("connection", signal);
    return new Promise<SshClient>((resolve, reject) => {
      let settled = false;
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        act();
      };
      const onAbort = () => finish(() => reject(abortError("connection", signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      attempt.then(
        (client) => finish(() => resolve(client)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private async connect(): Promise<SshClient> {
    if (this.client) {
      this.throwIfAborted("connection");
      return this.client;
    }
    if (this.connecting) return this.awaitConnection(this.connecting);

    const attempt = (async () => {
      const client = await connectSshClient(this.config);

      const onTransportDown = (cause?: Error) => {
        if (this.client !== client) return; // superseded / already handled
        this.client = null;
        this.sftpChannel = null; // channel died with the client
        this.sftpWrapper = null;
        this.handleDisconnect(cause);
      };

      client.on("close", () => onTransportDown());
      client.on("end", () => onTransportDown());
      client.on("error", (err: Error) => onTransportDown(err));

      this.client = client;
      return client;
    })();

    this.connecting = attempt;

    // Drop the memo however it settles, not just on success. A rejected promise
    // left cached here is permanent: once one connect failed, every later host
    // operation replayed that same rejection without redialing, so opening the
    // firewall that caused it (#490) appeared to change nothing until the API
    // process restarted.
    const clearMemo = () => {
      if (this.connecting === attempt) this.connecting = null;
    };
    attempt.then(clearMemo, clearMemo);

    return this.awaitConnection(attempt);
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
    this.rejectInflight(err);
    for (const cb of [...this.disconnectListeners]) {
      try { cb(err); } catch { /* a listener bug must not break disconnect handling */ }
    }
  }

  private rejectInflight(err: Error): void {
    const aborts = [...this.inflight];
    this.inflight.clear();
    for (const abort of aborts) {
      try { abort(err); } catch { /* per-op settle guard handles double-settle */ }
    }
  }

  private async waitForChannelClose(
    channel: SFTPWrapper | ClientChannel,
    close: () => void,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (closed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeListener("close", onClose);
        channel.removeListener("error", onError);
        resolve(closed);
      };
      const onClose = () => finish(true);
      // Keep an error listener installed while close is pending, but do not
      // mistake `error` for proof that the remote channel has quiesced.
      const onError = () => {};
      const timer = setTimeout(() => finish(false), CHANNEL_CLOSE_GRACE_MS);
      timer.unref?.();
      channel.once("close", onClose);
      channel.once("error", onError);
      try {
        close();
      } catch {
        finish(false);
      }
    });
  }

  /** Hard transport reset used only when a channel cannot prove it closed.
   * Every operation on that transport is rejected before we return, and a
   * later operation must establish a fresh connection. */
  private async forceResetTransport(client: SshClient, cause: Error): Promise<void> {
    if (this.client !== client) return;
    this.client = null;
    this.connecting = null;
    this.sftpChannel = null;
    this.sftpWrapper = null;
    if (this.reverseListenerClient === client) this.reverseListenerClient = null;

    this.rejectInflight(
      new SshDisconnectedError(`SSH connection reset to quiesce an operation: ${cause.message}`),
    );

    let closed = false;
    const closePromise = new Promise<void>((resolve) => {
      const done = () => {
        if (closed) return;
        closed = true;
        resolve();
      };
      client.once("close", done);
      client.once("end", done);
    });
    try { client.end(); } catch {}
    // `end()` is graceful and can itself wait behind a wedged subsystem.
    // Destroy the socket as the authoritative bounded cancellation fallback.
    try { client.destroy(); } catch {}
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TRANSPORT_CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  }

  private quiesceSftp(
    client: SshClient,
    wrapper: SFTPWrapper | null,
    cause: Error,
  ): Promise<void> {
    if (wrapper) {
      const existing = this.sftpQuiescence.get(wrapper);
      if (existing) return existing;
    }
    const quiescence = this.quiesceSftpOnce(client, wrapper, cause);
    if (wrapper) this.sftpQuiescence.set(wrapper, quiescence);
    return quiescence;
  }

  private async quiesceSftpOnce(
    client: SshClient,
    wrapper: SFTPWrapper | null,
    cause: Error,
  ): Promise<void> {
    if (!wrapper || this.sftpWrapper === wrapper) {
      this.sftpChannel = null;
      this.sftpWrapper = null;
    }
    if (wrapper) {
      const closed = await this.waitForChannelClose(wrapper, () => wrapper.end());
      if (closed) return;
    }
    await this.forceResetTransport(client, cause);
  }

  private awaitSftpOpen(
    opening: Promise<SFTPWrapper>,
    client: SshClient,
  ): Promise<SFTPWrapper> {
    const signal = this.operationSignal();
    this.throwIfAborted("SFTP channel open", signal);

    return new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.inflight.delete(abort);
        signal?.removeEventListener("abort", onSignalAbort);
      };
      const finish = (act: () => void) => {
        if (settled || terminating) return;
        settled = true;
        cleanup();
        act();
      };
      const terminate = (error: Error) => {
        if (settled || terminating) return;
        terminating = true;
        cleanup();
        const settle = () => {
          settled = true;
          reject(error);
        };
        void this.forceResetTransport(client, error).then(settle, settle);
      };
      const abort = (error: Error) => terminate(error);
      const onSignalAbort = () => terminate(abortError("SFTP channel open", signal!));
      const timer = setTimeout(
        () => terminate(new Error(`SFTP channel open timed out after ${SFTP_OPERATION_TIMEOUT_MS}ms`)),
        SFTP_OPERATION_TIMEOUT_MS,
      );
      timer.unref?.();
      this.inflight.add(abort);
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) {
        onSignalAbort();
        return;
      }
      opening.then(
        (wrapper) => finish(() => resolve(wrapper)),
        (error) => finish(() => reject(error)),
      );
    });
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
    this.throwIfAborted("SFTP channel open");
    if (this.sftpChannel) return this.awaitSftpOpen(this.sftpChannel, client);

    const opening = openSftp(client).then((wrapper) => {
      // A cancelled/timed-out opener may complete late.  Never publish that
      // orphan channel into the next deployment's fresh transport lifecycle.
      if (this.client !== client || this.sftpChannel !== opening) {
        try { wrapper.end(); } catch {}
        throw new SshDisconnectedError("SFTP channel opened after its SSH transport was reset");
      }
      const drop = () => {
        if (this.sftpChannel === opening) {
          this.sftpChannel = null;
          this.sftpWrapper = null;
        }
      };
      wrapper.once("close", drop);
      wrapper.once("error", drop);
      this.sftpWrapper = wrapper;
      return wrapper;
    });
    opening.catch(() => {
      if (this.sftpChannel === opening) this.sftpChannel = null;
    });
    this.sftpChannel = opening;
    return this.awaitSftpOpen(opening, client);
  }

  /** Close + forget the shared SFTP channel (frees its session) without
   *  touching the SSH client, so file ops can reopen on the same connection. */
  private dropSftp(): void {
    const ch = this.sftpChannel;
    this.sftpChannel = null;
    this.sftpWrapper = null;
    if (ch) ch.then((w) => { try { w.end(); } catch {} }).catch(() => {});
  }

  /**
   * Force-close the current connection so the next call reconnects.
   */
  private resetConnection(): void {
    this.dropSftp();
    if (this.client) {
      try { this.client.end(); } catch {}
      try { this.client.destroy(); } catch {}
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

  /** Returns true if the error is an SSH channel-open or channel-exec failure. */
  private static isChannelError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (isSshExecRequestError(err)) return true;
    const msg = err.message.toLowerCase();
    return msg.includes("channel open failure") || msg.includes("open failed");
  }

  /**
   * Run an operation, and if it fails opening an SSH channel on a half-dead
   * cached connection ("Channel open failure: open failed" — common after the
   * idle timeout drops the socket), recover channel capacity and retry ONCE.
   * An idle connection is replaced; a busy one stays alive so its other command
   * is not aborted (see recoverFromChannelError). The SFTP-based ops
   * (writeFile/readFile/exists) must go through this too, or a deploy's route
   * write fails spuriously and only succeeds on a manual redeploy.
   */
  private async withChannelRetry<T>(fn: () => Promise<T>): Promise<T> {
    this.throwIfAborted("operation");
    try {
      return await fn();
    } catch (err) {
      if (SshExecutor.isChannelError(err) && !this.operationSignal()?.aborted) {
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
    const signal = this.operationSignal();
    this.throwIfAborted("command", signal);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let channel: ClientChannel | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.inflight.delete(abort);
        signal?.removeEventListener("abort", onSignalAbort);
      };
      const finish = (act: () => void) => {
        if (settled || terminating) return;
        settled = true;
        cleanup();
        act();
      };
      // Do not reject until the command channel has closed. Releasing a host
      // mutation lock while the remote command keeps running is not atomic.
      const terminate = (error: Error) => {
        if (settled || terminating) return;
        terminating = true;
        cleanup();
        const quiesce = (async () => {
          if (channel) {
            const closed = await this.waitForChannelClose(channel, () => channel!.close());
            if (!closed) await this.forceResetTransport(client, error);
          } else {
            // A lost `client.exec` callback gives us no channel to close.
            await this.forceResetTransport(client, error);
          }
        })();
        const settle = () => {
          settled = true;
          reject(error);
        };
        void quiesce.then(settle, settle);
      };
      const abort = (err: Error) => terminate(err);
      const onSignalAbort = () => terminate(abortError("command", signal!));
      this.inflight.add(abort);
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) {
        onSignalAbort();
        return;
      }

      timer = setTimeout(
        () => terminate(new Error(`Command timed out after ${timeout}ms: ${commandForError(command)}`)),
        timeout,
      );
      timer.unref?.();

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return finish(() => reject(tagExecRequestError(err)));
        channel = stream;
        if (terminating) {
          try { stream.close(); } catch {}
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("error", (error: Error) => finish(() => reject(error)));

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
    opts?: { signal?: AbortSignal },
  ): Promise<{ code: number; output: string }> {
    const scopedOpts = { ...opts, signal: this.resolvedSignal(opts?.signal) };
    return this._streamExec(command, onLog, scopedOpts).catch((err) => {
      if (SshExecutor.isChannelError(err) && !scopedOpts.signal?.aborted) {
        this.recoverFromChannelError();
        return this._streamExec(command, onLog, scopedOpts);
      }
      throw err;
    });
  }

  private async _streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<{ code: number; output: string }> {
    const client = await this.connect();
    const signal = opts?.signal;

    return new Promise<{ code: number; output: string }>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      // Hoisted so an abort mid-stream can still hand back what did arrive.
      const chunks: string[] = [];
      let channel: ClientChannel | null = null;

      const cleanup = () => {
        this.inflight.delete(abort);
        signal?.removeEventListener("abort", onSignalAbort);
      };
      const finish = (act: () => void) => {
        if (settled || terminating) return;
        settled = true;
        cleanup();
        act();
      };
      const terminate = (error: Error, intentional: boolean) => {
        if (settled || terminating) return;
        terminating = true;
        cleanup();
        const quiesce = (async () => {
          if (channel) {
            const closed = await this.waitForChannelClose(channel, () => channel!.close());
            if (!closed) await this.forceResetTransport(client, error);
          } else {
            await this.forceResetTransport(client, error);
          }
        })();
        const settle = () => {
          settled = true;
          if (intentional) resolve({ code: 0, output: chunks.join("") });
          else reject(error);
        };
        void quiesce.then(settle, settle);
      };
      // A transport drop mid-stream rejects with SshDisconnectedError instead
      // of silently resolving `code ?? 1` (truncated output). Callers treat the
      // throw as a real failure; the manager can reconnect/re-drive.
      const abort = (err: Error) => terminate(err, false);
      const onSignalAbort = () => terminate(abortError("streaming command", signal!), true);
      this.inflight.add(abort);
      signal?.addEventListener("abort", onSignalAbort, { once: true });

      // Caller-driven teardown (a disconnected browser tearing down the log stream).
      // Closing the ssh2 channel closes the sshd side too, which breaks the remote
      // `docker exec curl`'s stdout pipe (the daemon buffers it, so nothing else ever
      // gives it an EPIPE) and lets it exit — instead of lingering until pipe_stream's
      // 1h cap and holding an SSH channel that would eventually starve MaxSessions. An
      // intentional abort is not a failure, so resolve with whatever bytes arrived —
      // but only AFTER close/reset proves the transport has quiesced.
      if (signal?.aborted) {
        onSignalAbort();
        return;
      }

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return finish(() => reject(tagExecRequestError(err)));
        channel = stream;
        // The abort may have fired between the check above and the channel opening.
        if (terminating || signal?.aborted) {
          try { stream.close(); } catch {}
          return;
        }

        // Raw passthrough (see LocalExecutor.streamExec): forward the untouched
        // byte stream as rawData so the client's xterm renders "\r"/ANSI
        // natively — progress lines repaint in place instead of new lines.
        const onChunk = (data: Buffer, level: LogEntry["level"]) => {
          const text = data.toString();
          if (!text) return;
          chunks.push(text);
          onLog(logEntry(text, level, data.toString("base64")));
        };

        stream.on("data", (data: Buffer) => onChunk(data, "info"));
        stream.stderr.on("data", (data: Buffer) => onChunk(data, "warn"));
        stream.on("error", (error: Error) => finish(() => reject(error)));

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

  /** Turn ssh2's callback-only SFTP request into a bounded operation.  A lost
   * callback used to leave the compose deploy promise and its host mutex tail
   * pending forever.  Cancellation/timeout closes the shared subsystem first;
   * if close itself wedges, the parent SSH transport is destroyed before this
   * promise rejects. */
  private runSftpRequest<T>(
    client: SshClient,
    sftp: SFTPWrapper,
    operation: string,
    start: (done: (error?: Error | null, value?: T) => void) => void,
  ): Promise<T> {
    const signal = this.operationSignal();
    this.throwIfAborted(operation, signal);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.inflight.delete(abort);
        signal?.removeEventListener("abort", onSignalAbort);
      };
      const finish = (act: () => void) => {
        if (settled || terminating) return;
        settled = true;
        cleanup();
        act();
      };
      const terminate = (error: Error) => {
        if (settled || terminating) return;
        terminating = true;
        cleanup();
        const settle = () => {
          settled = true;
          reject(error);
        };
        void this.quiesceSftp(client, sftp, error).then(settle, settle);
      };
      const abort = (error: Error) => terminate(error);
      const onSignalAbort = () => terminate(abortError(operation, signal!));
      const timer = setTimeout(
        () => terminate(new Error(`${operation} timed out after ${SFTP_OPERATION_TIMEOUT_MS}ms`)),
        SFTP_OPERATION_TIMEOUT_MS,
      );
      timer.unref?.();
      this.inflight.add(abort);
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) {
        onSignalAbort();
        return;
      }

      try {
        start((error, value) => {
          if (error) finish(() => reject(error));
          else finish(() => resolve(value as T));
        });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    const dir = remoteDirname(path);
    try {
      await this.exec(`mkdir -p ${sq(dir)}`);
    } catch {
      // Best effort
    }

    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      const client = this.client;
      if (!client) throw new SshDisconnectedError("SSH connection lost before SFTP write");
      const write = (data: string, mode?: number) =>
        this.runSftpRequest<void>(client, sftp, `SFTP write ${path}`, (done) => {
          sftp.writeFile(path, data, { encoding: "utf-8", mode }, (err) => done(err));
        });
      const chmod = (mode: number) =>
        this.runSftpRequest<void>(client, sftp, `SFTP chmod ${path}`, (done) => {
          sftp.chmod(path, mode, (err) => done(err));
        });

      if (opts?.mode !== undefined) {
        // SFTP's creation mode does not change an existing inode. Truncate it
        // empty, tighten it, then send the payload so no secret bytes exist
        // while the old permissive mode is still in force.
        await write("", opts.mode);
        await chmod(opts.mode);
        await write(content);
      } else {
        await write(content);
      }
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.exec(`mv ${sq(from)} ${sq(to)}`);
  }

  async readFile(path: string): Promise<string> {
    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      const client = this.client;
      if (!client) throw new SshDisconnectedError("SSH connection lost before SFTP read");
      return this.runSftpRequest<string>(client, sftp, `SFTP read ${path}`, (done) => {
        sftp.readFile(path, { encoding: "utf-8" }, (err, data) => {
          done(err, data?.toString());
        });
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      const client = this.client;
      if (!client) throw new SshDisconnectedError("SSH connection lost before SFTP stat");
      return this.runSftpRequest<boolean>(client, sftp, `SFTP stat ${path}`, (done) => {
        sftp.stat(path, (err) => {
          // ENOENT and permission errors both retain the historical `false`
          // contract; only a missing callback is now a bounded failure.
          done(null, !err);
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
   * Pipe `body` into a remote command's stdin over a raw ssh2 channel, half-
   * closing stdin at EOF. The streaming inverse of rawExec: used to stream a
   * `docker save` tar straight into `docker load` on another host without
   * staging the (multi-GB) image to a temp file. Bounded stderr tail for
   * diagnostics; registered for transport-drop abort like _exec/_streamExec.
   */
  execWithInput(command: string, body: Readable): Promise<{ code: number; stderr: string; stdout: string }> {
    return (async () => {
      const client = await this.connect();
      return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
        let settled = false;
        const abort = (err: Error) => finish(() => reject(err));
        const finish = (act: () => void) => {
          if (settled) return;
          settled = true;
          this.inflight.delete(abort);
          act();
        };
        this.inflight.add(abort);

        client.exec(command, (err, stream) => {
          if (err) return finish(() => reject(err));

          let stderr = "";
          stream.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
            if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
          });
          // Capture stdout (docker load prints "Loaded image( ID)?: <ref>", which
          // the caller needs to retag) AND keep the channel flowing so it doesn't
          // stall on an unread buffer.
          let stdout = "";
          stream.on("data", (d: Buffer) => {
            stdout += d.toString();
            if (stdout.length > 16 * 1024) stdout = stdout.slice(-16 * 1024);
          });

          let exitCode: number | null = null;
          stream.on("exit", (code: number | null) => {
            exitCode = code;
          });
          stream.on("close", (code: number | null) => {
            finish(() => {
              const final = typeof code === "number" ? code : exitCode;
              if (final == null) {
                reject(
                  new Error(
                    "remote channel closed without an exit status — the SSH connection was terminated mid-command",
                  ),
                );
              } else {
                resolve({ code: final, stderr: stderr.trim(), stdout: stdout.trim() });
              }
            });
          });

          // body → channel stdin; end() sends EOF so the reader exits.
          body.on("error", (e) => finish(() => { try { stream.close(); } catch {} reject(e); }));
          stream.on("error", (e: Error) => finish(() => reject(e)));
          body.pipe(stream);
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

  /**
   * Carry the Docker Engine API over a `docker system dial-stdio` exec channel
   * on the pooled connection — the streamlocal-free transport used when the
   * SSH server (or the Bun-compiled desktop runtime) can't do socket
   * forwarding.
   *
   * Deliberately WITHOUT `ENV_PREFIX`: that prefix only exports apt's
   * non-interactive variables (it sets no PATH, despite what the comment here
   * used to claim), and the bridge's own ephemeral dial-stdio client opens the
   * bare command. Two dial-stdio channels that differ by a shell prefix are two
   * transports, and the bridge picks one by probing the other.
   *
   * Failure diagnostics (daemon down, socket permission, `docker: command not
   * found`, an sshd ForceCommand banner) ride ON the returned channel — see
   * `attachDialStdioDiagnostics`. They used to go to `console.warn` while the
   * caller got a bare socket reset, which is how a host with no running dockerd
   * reported itself as `socket hang up`.
   */
  async openDockerDialStdio(): Promise<Duplex> {
    const client = await this.connect();
    return openDockerDialStdioChannel(client);
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
    this.sftpWrapper = null;
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
      await this.exec(`mkdir -p ${sq(remoteDirname(remoteArchive))}`);

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
