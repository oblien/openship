import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm as fsRm, stat, unlink } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

import { TRANSFER_EXCLUDES, formatBytes, safeErrorMessage } from "@repo/core";

import { getTarCreateArgs } from "../archive";
import type {
  CommandExecutor,
  LogEntry,
  ShellOptions,
  ShellSession,
  SshConfig,
} from "../types";
import { logEntry, sq } from "./local-shell";
import { extractRemoteArchive, packLocalArchive } from "./remote-transfer";
import {
  buildBaseSshArgs,
  makeControlPath,
  sshChildEnv,
  sshTarget,
} from "./system-ssh";
import { SshDisconnectedError } from "./errors";

const execFileAsync = promisify(execFile);

/** Clamp a PTY window dimension to a sane range (mirrors SshExecutor). */
function clampWindow(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Map a raw `ssh` failure to an Error message. SSH-level failures exit 255; we
 * tag genuine auth failures with the phrase `isSshAuthError` (errors.ts) looks
 * for, so test-connection still reports "Authentication failed" cleanly.
 */
function describeSshFailure(stderr: string, fallback: string): Error {
  const text = stderr.trim() || fallback;
  if (/permission denied|authentication failed|too many authentication failures/i.test(text)) {
    return new Error(`All configured authentication methods failed: ${text}`);
  }
  return new Error(text);
}

/**
 * Runs commands on a remote server via the OS `ssh` binary.
 *
 * Used for "agent" auth, where only the real OpenSSH client reliably resolves
 * the agent / `~/.ssh/config` / default keys / macOS keychain (the same thing
 * that makes `ssh root@host` work). Everything — exec, file ops, transfer,
 * port-forward, Docker socket-forward, the interactive shell — rides ONE
 * authenticated OpenSSH ControlMaster connection. Password/key auth keep using
 * the in-process `ssh2` SshExecutor.
 */
export class SystemSshExecutor implements CommandExecutor {
  private readonly config: SshConfig;
  private readonly controlPath = makeControlPath();
  /** Resolves once the ControlMaster connection is established. */
  private masterPromise: Promise<void> | null = null;
  /** Remote-socket → local-forward-socket, one StreamLocal forward per target. */
  private socketForwards = new Map<string, Promise<string>>();
  private readonly localSockets = new Set<string>();
  private readonly disconnectListeners = new Set<(err: Error) => void>();
  private disposed = false;

  /** Prefix applied to every remote command - keeps dpkg non-interactive. */
  private static readonly ENV_PREFIX =
    "export DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew && ";

  constructor(config: SshConfig) {
    if (!config.host) {
      throw new Error("System SSH executor requires a host.");
    }
    this.config = config;
  }

  private baseArgs(): string[] {
    return buildBaseSshArgs(this.config, this.controlPath);
  }

  onDisconnect(cb: (err: Error) => void): () => void {
    this.disconnectListeners.add(cb);
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  /**
   * On an SSH-level failure (exit 255 — which OpenSSH uses for ANY ssh-level
   * error: a dropped transport AND an auth failure alike, with no granular
   * code to tell them apart), authoritatively probe the ControlMaster with
   * `ssh -O check` instead of guessing from locale/version-dependent stderr.
   * Only a genuinely-dead master counts as a disconnect: we null it so the
   * next op reopens, and notify subscribers so the manager can react.
   */
  private async maybeSignalDisconnect(code: number): Promise<void> {
    if (code !== 255 || this.disposed) return;
    // Already torn down by an earlier signal for this master — debounce.
    if (!this.masterPromise) return;
    if (await this.isMasterAlive()) return; // alive => this 255 was auth/command, not a drop
    this.masterPromise = null;
    const err = new SshDisconnectedError("SSH master connection lost");
    for (const cb of [...this.disconnectListeners]) {
      try { cb(err); } catch { /* listener bug must not break disconnect handling */ }
    }
  }

  /** Authoritative ControlMaster liveness check: `ssh -O check` exits 0
   *  ("Master running") when the multiplex socket is alive, non-zero when it's
   *  missing/dead. Immune to stderr locale/version drift. */
  private async isMasterAlive(): Promise<boolean> {
    try {
      await execFileAsync("ssh", [...this.baseArgs(), "-O", "check", sshTarget(this.config)], {
        timeout: 5_000,
        env: sshChildEnv(this.config),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Open (once) the multiplexed master connection. Authenticates here. */
  private async ensureMaster(): Promise<void> {
    if (this.masterPromise) return this.masterPromise;
    this.masterPromise = (async () => {
      try {
        // -f backgrounds after auth, -N runs no command: the foreground
        // process exits 0 once the master socket is live, non-zero on
        // auth/connection failure (with the reason on stderr).
        await execFileAsync("ssh", [...this.baseArgs(), "-fN", sshTarget(this.config)], {
          timeout: 30_000,
          env: sshChildEnv(this.config),
        });
      } catch (err) {
        this.masterPromise = null; // allow a later retry
        const e = err as { stderr?: string };
        throw describeSshFailure(e.stderr ?? "", safeErrorMessage(err));
      }
    })();
    return this.masterPromise;
  }

  /** Run a remote command, resolving with stdout/stderr/exit code (never rejects on non-zero). */
  private async runSsh(
    remoteCommand: string,
    opts?: { timeout?: number; input?: string },
  ): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
    await this.ensureMaster();
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", [...this.baseArgs(), sshTarget(this.config), remoteCommand], {
        env: sshChildEnv(this.config),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (opts?.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeout);
        timer.unref?.();
      }

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`ssh failed to start: ${e.message}`));
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const c = code ?? 1;
        void this.maybeSignalDisconnect(c).catch(() => {});
        resolve({ stdout, stderr, code: c, timedOut });
      });

      if (opts?.input !== undefined) {
        child.stdin.write(opts.input);
      }
      // Always close stdin so the remote command sees EOF and never blocks
      // waiting on input it won't get.
      child.stdin.end();
    });
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    const timeout = opts?.timeout ?? 30_000;
    const res = await this.runSsh(SystemSshExecutor.ENV_PREFIX + command, { timeout });
    if (res.timedOut) {
      throw new Error(`Command timed out after ${timeout}ms: ${command}`);
    }
    if (res.code !== 0) {
      // 255 is an SSH-level failure (auth/connection); map auth specially so
      // it surfaces as a clean credentials error.
      if (res.code === 255) throw describeSshFailure(res.stderr, `Exit code ${res.code}`);
      throw new Error(res.stderr.trim() || `Exit code ${res.code}`);
    }
    return res.stdout.trim();
  }

  async streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    await this.ensureMaster();
    return new Promise((resolve) => {
      const child = spawn(
        "ssh",
        [...this.baseArgs(), sshTarget(this.config), SystemSshExecutor.ENV_PREFIX + command],
        { env: sshChildEnv(this.config), stdio: ["ignore", "pipe", "pipe"] },
      );

      // Raw passthrough (see LocalExecutor.streamExec): forward the untouched
      // byte stream as rawData so the client's xterm renders "\r"/ANSI natively
      // — remote builds get in-place progress repaints too, not new lines.
      const chunks: string[] = [];

      const onChunk = (chunk: Buffer, level: LogEntry["level"]) => {
        const text = chunk.toString();
        if (!text) return;
        chunks.push(text);
        onLog(logEntry(text, level, chunk.toString("base64")));
      };

      child.stdout.on("data", (chunk: Buffer) => onChunk(chunk, "info"));
      child.stderr.on("data", (chunk: Buffer) => onChunk(chunk, "warn"));
      child.on("error", (err) => {
        onLog(logEntry(`Process error: ${err.message}`, "error"));
        resolve({ code: 1, output: err.message });
      });
      child.on("close", (code) => {
        const c = code ?? 1;
        void this.maybeSignalDisconnect(c).catch(() => {});
        resolve({ code: c, output: chunks.join("") });
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const remoteCommand = `mkdir -p ${sq(dirname(path))} && cat > ${sq(path)}`;
    const res = await this.runSsh(remoteCommand, { input: content });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Failed to write ${path} (exit ${res.code})`);
    }
  }

  async readFile(path: string): Promise<string> {
    const res = await this.runSsh(`cat ${sq(path)}`);
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Failed to read ${path} (exit ${res.code})`);
    }
    return res.stdout; // unlike exec(), preserve exact bytes/newlines
  }

  async exists(path: string): Promise<boolean> {
    const res = await this.runSsh(`test -e ${sq(path)}`);
    return res.code === 0;
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

  /** Pipe a local command's stdout into a remote command's stdin over ssh. */
  private async pipeLocal(
    localCmd: string,
    remoteCmd: string,
    onLog?: (log: LogEntry) => void,
    onBytes?: (bytes: number) => void,
  ): Promise<{ code: number }> {
    await this.ensureMaster();
    return new Promise((resolve, reject) => {
      onLog?.(logEntry(`local: ${localCmd}`));

      const remote = spawn("ssh", [...this.baseArgs(), sshTarget(this.config), remoteCmd], {
        env: sshChildEnv(this.config),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const local = spawn("sh", ["-c", localCmd], { stdio: ["ignore", "pipe", "pipe"] });

      if (onBytes) {
        local.stdout.on("data", (chunk: Buffer) => onBytes(chunk.length));
      }
      local.stdout.pipe(remote.stdin);

      local.stderr.on("data", (d: Buffer) => {
        const text = d.toString().trim();
        if (text) onLog?.(logEntry(`local stderr: ${text}`, "warn"));
      });
      remote.stderr.on("data", (d: Buffer) => {
        const text = d.toString().trim();
        if (text) onLog?.(logEntry(`remote stderr: ${text}`, "warn"));
      });

      local.on("error", (e) => reject(new Error(`Local process failed to start: ${e.message}`)));
      remote.on("error", (e) => reject(new Error(`ssh failed to start: ${e.message}`)));
      remote.on("close", (code) => resolve({ code: code ?? 1 }));
    });
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[] },
  ): Promise<void> {
    // Pack the tree into ONE archive, stream that single file over the existing
    // OpenSSH ControlMaster (multiplexed channel, no new handshake, no rsync,
    // no per-file overhead), then verify + extract on the server.
    const excludes = options?.excludes ?? [...TRANSFER_EXCLUDES];
    const tarArgs = getTarCreateArgs(localPath, { excludes, includes: options?.includes });
    const tmpLocalDir = await mkdtemp(join(tmpdir(), "openship-xfer-"));
    const localArchive = join(tmpLocalDir, "context.tar.gz");
    // Sibling of the destination dir so it lands on the same filesystem.
    const remoteArchive = `${remotePath}.openship-xfer.tar.gz`;

    try {
      onLog?.(logEntry("Packing source into a single archive..."));
      await packLocalArchive(tarArgs, localArchive);
      const totalBytes = (await stat(localArchive)).size;
      await this.exec(`mkdir -p ${sq(dirname(remoteArchive))}`);
      onLog?.(logEntry(`Uploading ${formatBytes(totalBytes)} archive over the SSH connection...`));
      const { code } = await this.pipeLocal(`cat ${sq(localArchive)}`, `cat > ${sq(remoteArchive)}`, onLog);
      if (code !== 0) throw new Error(`archive upload failed (exit ${code})`);
      await extractRemoteArchive((command) => this.exec(command), remoteArchive, remotePath, totalBytes, onLog);
    } finally {
      await fsRm(tmpLocalDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async forwardPort(remoteHost: string, remotePort: number): Promise<Duplex> {
    await this.ensureMaster();
    // -W wires this ssh process's stdio straight to remoteHost:remotePort
    // through the master. The child's stdin/stdout become the byte tunnel.
    const child = spawn(
      "ssh",
      [...this.baseArgs(), "-W", `${remoteHost}:${remotePort}`, sshTarget(this.config)],
      { env: sshChildEnv(this.config), stdio: ["pipe", "pipe", "ignore"] },
    );
    const duplex = Duplex.from({ writable: child.stdin, readable: child.stdout });
    duplex.on("close", () => { try { child.kill(); } catch { /* already gone */ } });
    child.on("exit", () => { duplex.destroy(); });
    child.on("error", (e) => { duplex.destroy(e); });
    return duplex;
  }

  /** Ensure a StreamLocal forward (local unix socket → remote socket) on the master. */
  private async ensureSocketForward(remoteSocket: string): Promise<string> {
    let pending = this.socketForwards.get(remoteSocket);
    if (!pending) {
      pending = (async () => {
        await this.ensureMaster();
        const localSocket = `/tmp/openship-fwd-${process.pid}-${randomBytes(6).toString("hex")}.sock`;
        await execFileAsync(
          "ssh",
          [...this.baseArgs(), "-O", "forward", "-L", `${localSocket}:${remoteSocket}`, sshTarget(this.config)],
          { timeout: 15_000, env: sshChildEnv(this.config) },
        );
        this.localSockets.add(localSocket);
        return localSocket;
      })();
      // Don't cache a failed forward — evict so the next call re-establishes it.
      pending.catch(() => {
        if (this.socketForwards.get(remoteSocket) === pending) {
          this.socketForwards.delete(remoteSocket);
        }
      });
      this.socketForwards.set(remoteSocket, pending);
    }
    return pending;
  }

  async forwardUnixSocket(socketPath: string): Promise<Duplex> {
    const attempt = async (): Promise<Duplex> => {
      const localSocket = await this.ensureSocketForward(socketPath);
      const sock = netConnect(localSocket);
      await once(sock, "connect");
      return sock;
    };
    try {
      return await attempt();
    } catch {
      // Master/forward may have lapsed — re-establish once.
      this.socketForwards.delete(socketPath);
      return attempt();
    }
  }

  /**
   * Run a best-effort, fire-and-forget control command on the remote over the
   * existing master (no output captured, errors swallowed). Used for PTY
   * resize and marker cleanup.
   */
  private fireAndForget(command: string): void {
    try {
      spawn("ssh", [...this.baseArgs(), sshTarget(this.config), command], {
        env: sshChildEnv(this.config),
        stdio: "ignore",
      }).on("error", () => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  async openShell(opts?: ShellOptions): Promise<ShellSession> {
    await this.ensureMaster();

    const cols = clampWindow(opts?.cols, 80, 1, 1000);
    const rows = clampWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    // Under bun we can't allocate a LOCAL pty (node-pty's forkpty doesn't run
    // there), so the REMOTE owns the tty: `-tt` forces sshd to allocate a PTY
    // even though our local stdio are plain pipes. `stty sane` gives the shell
    // a clean cooked-mode baseline, we set the initial size, and stash the pty
    // device path so setWindow() can resize that exact pty over the master.
    const ptyMarker = `/tmp/openship-pty-${process.pid}-${randomBytes(6).toString("hex")}`;
    const remoteInit =
      `tty > ${ptyMarker} 2>/dev/null; ` +
      `stty sane 2>/dev/null; stty cols ${cols} rows ${rows} 2>/dev/null; ` +
      `exec "\${SHELL:-/bin/sh}" -l`;

    // TERM must be forwarded explicitly: ssh derives the remote terminal type
    // from our $TERM, and a GUI-launched API process often has none. A
    // missing/wrong TERM breaks zsh/zle cursor math (mis-placed prompts) —
    // this mirrors what the ssh2 path passed via client.shell({ term }).
    const env = { ...sshChildEnv(this.config), TERM: term };

    const child = spawn("ssh", [...this.baseArgs(), "-tt", sshTarget(this.config), remoteInit], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Writing to a dead shell or reading a closed pipe must not throw an
    // unhandled 'error' that takes down the API.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingSize: { c: number; r: number } | null = null;

    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      this.fireAndForget(`rm -f ${ptyMarker}`); // best-effort marker cleanup
      for (const cb of closeListeners) {
        try { cb(code, signal); } catch { /* listener bug shouldn't break cleanup */ }
      }
    };
    child.on("exit", (code, signal) => fireClose(code, signal ?? undefined));
    child.on("error", () => fireClose(null));

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      setWindow: (c: number, r: number) => {
        // Coalesce rapid resizes (window drag) into a single stty over the
        // master. The marker may not exist yet on the very first resize, so
        // the remote loop retries briefly. GNU stty uses -F, BSD -f (remote
        // deploy targets are Linux).
        pendingSize = { c: clampWindow(c, 80, 1, 1000), r: clampWindow(r, 24, 1, 500) };
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const size = pendingSize;
          pendingSize = null;
          if (!size || closed) return;
          this.fireAndForget(
            `for i in 1 2 3 4 5 6; do P=$(cat ${ptyMarker} 2>/dev/null); ` +
            `if [ -n "$P" ]; then stty -F "$P" cols ${size.c} rows ${size.r} 2>/dev/null || ` +
            `stty -f "$P" cols ${size.c} rows ${size.r} 2>/dev/null; break; fi; sleep 0.2; done`,
          );
        }, 60);
        resizeTimer.unref?.();
      },
      close: (_signal?: string) => {
        if (resizeTimer) clearTimeout(resizeTimer);
        try { child.kill(); } catch { /* already gone */ }
      },
      onClose: (cb) => { closeListeners.push(cb); },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Tear down the master (this also drops all forwards), then unlink the
    // local forward sockets best-effort.
    if (this.masterPromise) {
      try {
        await execFileAsync("ssh", [...this.baseArgs(), "-O", "exit", sshTarget(this.config)], {
          timeout: 5_000,
          env: sshChildEnv(this.config),
        });
      } catch { /* master may already be gone */ }
    }
    this.masterPromise = null;
    this.socketForwards.clear();
    for (const socket of this.localSockets) {
      await unlink(socket).catch(() => {});
    }
    this.localSockets.clear();
  }
}
