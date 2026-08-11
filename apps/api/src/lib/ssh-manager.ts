/**
 * SSH Connection Manager - per-server cached executors with idle-TTL.
 *
 * All server interactions go through `sshManager.acquire(serverId)` or
 * the convenience wrapper `sshManager.withExecutor(serverId, fn)`.
 *
 * Each serverId gets its own cached connection with an independent idle
 * timer. After idleTimeoutMs with no usage the connection drops silently.
 * Next acquire() reconnects from fresh DB settings.
 *
 * Invalidation:
 *   Call sshManager.invalidate(serverId) when a server's settings change
 *   or it is deleted.  Call sshManager.invalidate() (no arg) to drop all
 *   connections.
 *
 * Retry on error:
 *   withExecutor(serverId, fn) catches connection-level errors, invalidates,
 *   and retries fn once with a fresh executor. This handles stale
 *   connections transparently.
 *
 * Security:
 *   - SSH credentials are read from DB on each connect(), never cached
 *     in memory beyond the ssh2 client's internal state.
 *   - Idle timeout ensures connections don't linger when unused.
 *   - Timers use unref() so they don't prevent graceful shutdown.
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repos } from "@repo/db";
import {
  createExecutor,
  createHostExecutor,
  isRetryableRemoteConnectionError,
  probeTcp,
  runReliable,
  type CommandExecutor,
  type SshConfig,
} from "@repo/adapters";
import { formatDuration, systemDebug } from "@/lib/system-debug";
import { decryptSecretField } from "@/lib/credential-encryption";
import { resolveSafeSshKeyPath } from "@/lib/ssh-key-path";
import { isLocalHostRow } from "@/lib/box-org";
import { OPENSHIP_DIR } from "@/lib/openship-server-store";
import { safeErrorMessage } from "@repo/core";

const execFileAsync = promisify(execFile);

/**
 * Resolve the SSH agent socket for "agent" auth.
 *
 * The orchestrator is often a GUI-launched desktop app that never inherited the
 * user's `SSH_AUTH_SOCK` from a login shell — so plain `process.env` is empty
 * even though `ssh` works fine in the user's terminal. When the env var is
 * unset, ask the OS for the per-user agent socket: on macOS `launchctl getenv
 * SSH_AUTH_SOCK` returns it even for GUI processes (the same trick VS Code uses).
 * Returns null when no agent can be found.
 */
async function resolveSshAuthSock(): Promise<string | null> {
  // 1. Inherited env — covers shell- and service-launched processes on every
  //    platform (the common case for the dev server and self-hosted installs).
  const fromEnv = process.env.SSH_AUTH_SOCK;
  if (fromEnv) return fromEnv;

  // 2. GUI-launched apps (the desktop shell) often don't inherit it. Ask the
  //    OS session manager for the per-user value.
  if (process.platform === "darwin") {
    // macOS: the value lives in the launchd user session.
    try {
      const { stdout } = await execFileAsync("launchctl", ["getenv", "SSH_AUTH_SOCK"]);
      const sock = stdout.trim();
      if (sock) return sock;
    } catch {
      // launchctl missing / no value — fall through.
    }
  } else if (process.platform === "linux") {
    // Linux desktops that run an ssh-agent under the systemd user manager
    // (gnome-keyring, the ssh-agent.service unit) export it there.
    try {
      const { stdout } = await execFileAsync("systemctl", ["--user", "show-environment"]);
      const line = stdout.split("\n").find((l) => l.startsWith("SSH_AUTH_SOCK="));
      const sock = line?.slice("SSH_AUTH_SOCK=".length).trim();
      if (sock) return sock;
    } catch {
      // systemctl missing (non-systemd) / no value — fall through.
    }
  }
  // Windows: the OpenSSH agent is a named pipe, not a socket, and the
  // system-ssh path isn't supported there — return null. The caller still
  // proceeds; `ssh` resolves auth itself (default keys / config) or fails
  // with a clear error.
  return null;
}

// ─── Shared SSH config builder ───────────────────────────────────────────────

/** Settings shape accepted by `buildSshConfig`. */
export interface SshSettingsInput {
  sshHost: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthMethod?: string | null;
  sshPassword?: string | null;
  sshKeyPath?: string | null;
  sshKeyPassphrase?: string | null;
  sshJumpHost?: string | null;
  sshArgs?: string | null;
}

/**
 * Map a settings object → `SshConfig`.  Works for both DB rows and
 * plain request-body objects.  Returns `null` when the input is
 * incomplete or invalid (e.g. missing host, unreadable key file,
 * path-traversal attempt).
 */
export async function buildSshConfig(
  settings: SshSettingsInput,
): Promise<SshConfig | null> {
  if (!settings.sshHost) return null;

  const config: SshConfig = {
    host: settings.sshHost,
    port: settings.sshPort ?? 22,
    username: settings.sshUser ?? "root",
  };

  // Jump host / extra args are honored by the system-ssh path (agent auth).
  if (settings.sshJumpHost?.trim()) config.sshJumpHost = settings.sshJumpHost.trim();
  if (settings.sshArgs?.trim()) config.sshArgs = settings.sshArgs.trim();

  if (settings.sshAuthMethod === "password" && settings.sshPassword) {
    // Stored encrypted on insert; decrypted only here at the moment we
    // hand it to the ssh2 client.
    config.password = decryptSecretField(settings.sshPassword);
  } else if (settings.sshAuthMethod === "key" && settings.sshKeyPath) {
    // Centralised allowlist + traversal check — see lib/ssh-key-path.ts.
    // homedir() is the operator's home, used as the default convenient
    // root so `~/.ssh/openship` works without explicit env config.
    let keyPath: string;
    try {
      keyPath = resolveSafeSshKeyPath(settings.sshKeyPath, {
        extraRoots: [homedir()],
      });
    } catch {
      return null;
    }

    try {
      config.privateKey = readFileSync(keyPath, "utf-8");
    } catch {
      return null;
    }
    if (settings.sshKeyPassphrase) {
      config.privateKeyPassphrase = decryptSecretField(settings.sshKeyPassphrase);
    }
  } else if (settings.sshAuthMethod === "agent") {
    // "Agent" = authenticate exactly the way the operator's own `ssh <host>`
    // does. We route through the OS `ssh` binary (useSystemSsh): only the real
    // OpenSSH client reliably resolves the agent / ~/.ssh/config / default keys
    // / keychain. We best-effort locate the agent socket and inject it into the
    // ssh child's env (a GUI-launched app often lacks SSH_AUTH_SOCK). If none
    // is found we still proceed — ssh can fall back to default keys / config,
    // just like the terminal — and a genuine no-auth case surfaces as a clear
    // ssh error on connect rather than being pre-empted here.
    config.useSystemSsh = true;
    const sock = await resolveSshAuthSock();
    if (sock) config.sshAgent = sock;
  } else {
    return null;
  }

  return config;
}

function debugSsh(message: string): void {
  systemDebug("ssh-manager", message);
}

// ─── Options ─────────────────────────────────────────────────────────────────

interface SshManagerOptions {
  /** Idle timeout before dropping a cached connection (default: 5 min) */
  idleTimeoutMs?: number;
}

const DEFAULTS = {
  idleTimeoutMs: 5 * 60_000,
} as const;

// Circuit-breaker. After this many consecutive connect/command failures, a
// server is marked unhealthy and acquire() FAST-FAILS for COOLDOWN_MS instead
// of re-attempting — which otherwise re-eats a multi-second timeout on every
// poll tick (e.g. the 3s live-metrics SSE hammering an unreachable box with
// 5s command timeouts). One success resets it.
const FAIL_THRESHOLD = 2;
const COOLDOWN_MS = 30_000;

// ─── Reliable-run (journaled, exactly-once) tuning ─────────────────────────────

/** Max queued journaled ops per server before run() rejects (backpressure). */
const MAX_QUEUE_DEPTH = 100;
/** Overall deadline for a single journaled op across reconnects (15 min —
 *  installs/restores are long). Overridable per call. */
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
/** Reconnect backoff bounds while re-driving a journaled op (matches the
 *  tunnel-agent's 1s→30s doubling). */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RunOptions {
  /** Overall deadline across reconnects (default DEFAULT_RUN_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Per-invocation remote wait window, seconds (default 25). */
  waitSecs?: number;
  /** Env prefix for the journaled command (default REMOTE_ENV_PREFIX). */
  envPrefix?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Re-exported: a journaled op interrupted with no recorded exit (unknown
 * outcome). Canonical definition lives in @repo/adapters so the adapter
 * runtimes and the manager throw the same type.
 */
export { OpInterruptedError } from "@repo/adapters";

/** Constrain an opId to a filesystem/shell-safe slug (paths never need quoting
 *  in the wrapper, so opIds never carry spaces). */
function sanitizeOpId(opId: string): string {
  const s = opId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 200);
  if (!s) throw new Error("run() requires a non-empty opId");
  return s;
}

interface QueuedOp {
  opId: string;
  command: string;
  opts: RunOptions;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
}

interface OpQueue {
  ops: QueuedOp[];
  running: boolean;
}

// ─── Per-server connection state ─────────────────────────────────────────────

interface ServerConnection {
  executor: CommandExecutor;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Unsubscribe from the executor's onDisconnect, called when we drop it. */
  unsubDisconnect?: () => void;
  /**
   * This entry BORROWS an executor owned by another key (the host channel, shared
   * by every local row). Dropping it must forget the entry WITHOUT disposing the
   * executor — the owner and the other borrowers are still using it.
   */
  shared?: boolean;
}

/**
 * Reserved pool key for the HOST channel — the machine Openship itself runs on.
 *
 * Not a server id: the host channel is needed before any server row exists
 * (startup self-deploy, `selfEdgePreflight`) and is the same connection no matter
 * which local row asks for it. A reserved key keeps it in the one cache that has
 * idle cleanup, instead of a second lifecycle nobody remembers to close.
 */
const HOST_CHANNEL_KEY = "__openship_host__";

// ─── Manager ─────────────────────────────────────────────────────────────────

export class SshConnectionManager {
  private servers = new Map<string, ServerConnection>();
  private connecting = new Map<string, Promise<CommandExecutor>>();
  private retainCounts = new Map<string, number>();
  /**
   * Server-row ids we've classified as THIS host (they borrow the one host
   * channel under {@link HOST_CHANNEL_KEY}). Lets the sync lifecycle paths
   * (`acquire` routing, the idle-drop guard, `release` re-arm) recognise a local
   * row without an async DB lookup. Membership tracks a live borrow marker: added
   * on acquire, removed when the marker is dropped.
   */
  private localHostRows = new Set<string>();
  /** Per-server serial FIFO queue for journaled (mutating) ops — see run(). */
  private queues = new Map<string, OpQueue>();
  /** Executors whose remote journal wrapper is deployed (per-instance cache). */
  private journalReady = new WeakSet<CommandExecutor>();
  /** Circuit-breaker state per server (consecutive fails + cooldown deadline). */
  private health = new Map<string, { fails: number; unhealthyUntil: number }>();
  private destroyed = false;
  private readonly opts: Required<SshManagerOptions>;

  constructor(options?: SshManagerOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Get a cached executor for the given server, creating one if needed.
   * Resets the idle timer on every call.
   *
   * Throws if the server doesn't exist or auth is invalid.
   */
  async acquire(serverId: string): Promise<CommandExecutor> {
    const startedAt = Date.now();
    if (this.destroyed) throw new Error("SshManager has been destroyed");

    // A row we've ALREADY classified as this host resolves to the shared channel
    // directly — BEFORE the generic cache fast-path below. That path returns the
    // row's borrow marker (`.executor`), which goes stale the instant the owner is
    // reclaimed and rebuilt: it would hand back a DISPOSED executor. Routing through
    // acquireHostChannel re-validates the owner every call, and skips the DB lookup.
    if (this.localHostRows.has(serverId)) {
      return this.acquireLocalHost(serverId, startedAt);
    }

    const cached = this.servers.get(serverId);
    if (cached) {
      this.touchIdleTimer(serverId);
      debugSsh(`acquire:reuse server=${serverId} (${formatDuration(startedAt)})`);
      return cached.executor;
    }

    // Local host row → the host executor (LocalExecutor bare / SSH→host.docker.internal
    // containerized), NEVER a dial to the row's sshHost — for a loopback/self row that
    // is our OWN loopback (no sshd), which would hang the SSH connect timeout. Mirrors
    // resolveServerExecutor so probe-gated flows (Test Connection, Scan Ports) that call
    // acquire don't hang. Placed before the cooldown gate so a row that failed dialing
    // 127.0.0.1 before this fix isn't stuck "cooling down". Org-gated via isLocalHostRow.
    //
    // POOLED through the same cache as a remote server, and that matters: when the
    // API is containerized `createHostExecutor()` builds a NEW SshExecutor to the
    // host every call, so an unpooled path leaked one sshd session per call —
    // 8,000+ in hours, then OOM (#291). Every local row shares the one host channel.
    const row = await repos.server.get(serverId).catch(() => undefined);
    if (row && (await isLocalHostRow(row))) {
      return this.acquireLocalHost(serverId, startedAt);
    }

    // Circuit-breaker: a server that just failed repeatedly is in cooldown —
    // fast-fail instead of attempting (and waiting out) another timeout.
    const cooldownLeft = this.cooldownRemaining(serverId);
    if (cooldownLeft > 0) {
      debugSsh(`acquire:short-circuit server=${serverId} cooldown=${cooldownLeft}ms`);
      throw new Error(
        `Server is unreachable — cooling down after repeated failures, retry in ~${Math.ceil(cooldownLeft / 1000)}s.`,
      );
    }

    // Dedup concurrent acquire() calls for the same server
    const pending = this.connecting.get(serverId);
    if (pending) {
      debugSsh(`acquire:join-existing-connect server=${serverId}`);
      return pending;
    }

    debugSsh(`acquire:connect-start server=${serverId}`);
    const promise = this.connect(serverId);
    this.connecting.set(serverId, promise);
    try {
      const exec = await promise;
      this.cacheConnection(serverId, exec);
      debugSsh(`acquire:executor-ready server=${serverId} (${formatDuration(startedAt)})`);
      return exec;
    } catch (err) {
      const msg = safeErrorMessage(err);
      this.recordFailure(serverId);
      debugSsh(`acquire:failed server=${serverId} (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    } finally {
      this.connecting.delete(serverId);
    }
  }

  /**
   * Run an operation with automatic retry on connection errors.
   *
   * If `fn` fails with a connection-level error (reset, timeout, etc.),
   * the executor is invalidated and `fn` is retried once with a fresh
   * connection. Non-connection errors propagate immediately.
   *
   * SEMANTICS: this is AT-LEAST-ONCE — the retry re-runs `fn` wholesale with no
   * idempotency guard. Safe for reads and idempotent operations only. For
   * MUTATING commands that must not double-apply, use `run()` / `execJournaled()`
   * instead (exactly-once via the remote journal).
   */
  /**
   * Put an executor in the cache with the full bookkeeping: disconnect wiring,
   * idle timer, success record.
   *
   * One implementation on purpose. This sequence used to be inline in `acquire`,
   * and the moment a second path needed it the copy drifted — and the copy that
   * drifts is the one that leaks.
   */
  private cacheConnection(
    serverId: string,
    exec: CommandExecutor,
    opts: { shared?: boolean } = {},
  ): void {
    const conn: ServerConnection = { executor: exec, idleTimer: null, shared: opts.shared };
    // React to a transport drop the instant it happens (L1). The executor has
    // already rejected its own in-flight ops; here we drive manager-side recovery.
    // A borrowed entry doesn't subscribe — the OWNER's subscription already fires,
    // and a second one would drop the shared executor twice.
    if (!opts.shared && typeof exec.onDisconnect === "function") {
      conn.unsubDisconnect = exec.onDisconnect((err) => this.onExecutorDisconnect(serverId, err));
    }
    this.servers.set(serverId, conn);
    this.touchIdleTimer(serverId);
    this.recordSuccess(serverId);
  }

  /**
   * The pooled HOST channel — one connection to the machine Openship runs on,
   * reused by every caller and reclaimed by the same idle timer as a server.
   */
  private async acquireHostChannel(): Promise<CommandExecutor> {
    const cached = this.servers.get(HOST_CHANNEL_KEY);
    if (cached) {
      this.touchIdleTimer(HOST_CHANNEL_KEY);
      return cached.executor;
    }
    // Dedup concurrent first-acquires: without this, N simultaneous callers each
    // build their own SshExecutor and N-1 are orphaned — the leak in miniature.
    const pending = this.connecting.get(HOST_CHANNEL_KEY);
    if (pending) return pending;

    // createHostExecutor throws (deliberately) when the API is containerized with
    // no host channel provisioned. Let that propagate: callers must NOT silently
    // treat "cannot reach the host at all" as success.
    const promise = (async () => createHostExecutor())();
    this.connecting.set(HOST_CHANNEL_KEY, promise);
    try {
      const exec = await promise;
      this.cacheConnection(HOST_CHANNEL_KEY, exec);
      debugSsh("acquire:host-channel ready");
      return exec;
    } finally {
      this.connecting.delete(HOST_CHANNEL_KEY);
    }
  }

  /**
   * Resolve a LOCAL server row to the shared host channel, keeping a borrow marker
   * under the row id so `isConnected`/`probeReachable` short-circuit and the row
   * shows up in idle cleanup. Going through `acquireHostChannel` re-validates (and
   * rebuilds) the owner every call, so the marker can never hand back a stale or
   * disposed executor if the owner was reclaimed since the last acquire.
   */
  private async acquireLocalHost(serverId: string, startedAt: number): Promise<CommandExecutor> {
    this.localHostRows.add(serverId);
    const exec = await this.acquireHostChannel();
    this.cacheSharedMarker(serverId, exec);
    this.recordSuccess(serverId);
    debugSsh(`acquire:local-host server=${serverId} (${formatDuration(startedAt)})`);
    return exec;
  }

  /**
   * (Re)point a local row's borrow marker at the CURRENT host-channel executor.
   * Clears any prior idle timer first so a stale one can't drop the fresh marker,
   * and — like every cached entry — arms a new one unless the row is retained.
   * A marker never subscribes onDisconnect (the owner's subscription is the one)
   * and is never disposed on drop (see {@link dropServer}); it only borrows.
   */
  private cacheSharedMarker(serverId: string, exec: CommandExecutor): void {
    const existing = this.servers.get(serverId);
    if (existing?.idleTimer) clearTimeout(existing.idleTimer);
    this.servers.set(serverId, { executor: exec, idleTimer: null, shared: true });
    this.touchIdleTimer(serverId);
  }

  /**
   * Run `fn` against the HOST machine — the local box, over SSH when the API is
   * containerized.
   *
   * Use this for every "this machine" operation. The executor is POOLED, so there
   * is nothing to dispose and no way to leak one: the previous idiom handed out a
   * fresh `createHostExecutor()` and relied on each caller remembering a
   * `try/finally`, which is how #291 reached 8,000+ orphaned sshd sessions.
   * Deliberately mirrors `withExecutor(serverId, fn)` so there is one shape for
   * "give me an executor for X".
   */
  async withHostExecutor<T>(fn: (executor: CommandExecutor) => Promise<T>): Promise<T> {
    const exec = await this.acquireHostChannel();
    try {
      return await fn(exec);
    } finally {
      // Extend the idle window from LAST USE, not from acquisition, or a long op
      // can have the connection dropped from under its own tail.
      this.touchIdleTimer(HOST_CHANNEL_KEY);
    }
  }

  async withExecutor<T>(
    serverId: string,
    fn: (executor: CommandExecutor) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const executor = await this.acquire(serverId);
    try {
      const result = await fn(executor);
      this.recordSuccess(serverId);
      debugSsh(`withExecutor:done server=${serverId} (${formatDuration(startedAt)})`);
      return result;
    } catch (err) {
      if (isRetryableRemoteConnectionError(err)) {
        const msg = safeErrorMessage(err);
        debugSsh(`withExecutor:retry-after-connection-error server=${serverId} ${msg}`);
        this.dropServer(serverId);
        const freshExecutor = await this.acquire(serverId);
        const result = await fn(freshExecutor);
        this.recordSuccess(serverId);
        debugSsh(`withExecutor:retry-done server=${serverId} (${formatDuration(startedAt)})`);
        return result;
      }
      const msg = safeErrorMessage(err);
      // Connection errors and command timeouts count toward the breaker — a
      // sick/unreachable box shouldn't be re-hit every poll tick.
      if (isRetryableRemoteConnectionError(err) || /timed out|timeout|ETIMEDOUT/i.test(msg)) {
        this.recordFailure(serverId);
      }
      debugSsh(`withExecutor:failed server=${serverId} (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    }
  }

  /**
   * The executor reported a transport-level disconnect (L1). Phase 0: log it —
   * the executor already rejected its in-flight ops and self-heals on next use
   * (it re-dials when its client is null). Phase 1 drives reconnect + queue
   * drain from here. A retained connection is left alone: a live terminal /
   * stream owns it and receives its own close event.
   */
  private onExecutorDisconnect(serverId: string, err: Error): void {
    debugSsh(`disconnect-detected server=${serverId}: ${safeErrorMessage(err)}`);
  }

  /**
   * Run a MUTATING command with EXACTLY-ONCE semantics via remote journaling.
   *
   * Ops for one server run serially through a FIFO queue. The command is
   * launched detached on the remote and journaled by `opId`; if the transport
   * drops mid-command, the op is re-driven (with backoff) using the SAME opId,
   * so the wrapper HARVESTS the recorded result instead of re-running — no
   * duplication, and the in-flight result is recovered on reconnect.
   *
   * `opId` should be a stable, deterministic key for the logical operation
   * (e.g. `deploy:<deploymentId>:<step>`) so it also survives an orchestrator
   * restart. Throws `OpInterruptedError` if the op was interrupted with no
   * recorded exit (unknown outcome — caller decides, never auto-reruns).
   */
  async run(
    serverId: string,
    opId: string,
    command: string,
    opts: RunOptions = {},
  ): Promise<RunResult> {
    if (this.destroyed) throw new Error("SshManager has been destroyed");
    const safeOpId = sanitizeOpId(opId);
    return new Promise<RunResult>((resolve, reject) => {
      let q = this.queues.get(serverId);
      if (!q) {
        q = { ops: [], running: false };
        this.queues.set(serverId, q);
      }
      if (q.ops.length >= MAX_QUEUE_DEPTH) {
        reject(new Error(`SSH op queue full for server ${serverId} (max ${MAX_QUEUE_DEPTH})`));
        return;
      }
      q.ops.push({ opId: safeOpId, command, opts, resolve, reject });
      void this.drainQueue(serverId);
    });
  }

  /**
   * Like `run()` but throws on a non-zero exit and returns trimmed stdout — a
   * drop-in for `exec()` on mutating commands.
   */
  async execJournaled(
    serverId: string,
    opId: string,
    command: string,
    opts: RunOptions = {},
  ): Promise<string> {
    const r = await this.run(serverId, opId, command, opts);
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || r.stdout.trim() || `Exit code ${r.code}`);
    }
    return r.stdout.trim();
  }

  /** Whether there's an active connection for a given server. */
  isConnected(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  /**
   * Cheap reachability check that never establishes or caches an SSH session.
   * This is the single source of truth for "can we reach this server right
   * now" — delete/reconcile use it to fast-fail an unreachable host in ~2.5s
   * instead of paying the 15-20s SSH connect timeout per resource.
   *
   *   - live cached connection  → reachable (don't disturb it).
   *   - breaker in cooldown      → unreachable, WITHOUT any connection attempt
   *                                (the "no avoidable connection" fast path).
   *   - otherwise                → a bounded TCP probe to the SSH port; the
   *                                result feeds the same breaker the executor
   *                                paths use, so a sick box trips it even though
   *                                cleanup execs bypass `withExecutor`.
   *
   * Reuses `repos.server.get` — the same config source `connect()` uses — so
   * there is no second notion of server connectivity.
   */
  async probeReachable(serverId: string, timeoutMs = 2500): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.servers.has(serverId)) return true;
    if (this.cooldownRemaining(serverId) > 0) return false;

    const server = await repos.server.get(serverId).catch(() => undefined);
    if (!server) return false;

    // An isLocal row is THIS box (the auto-registered "This Server"). Its ssh*
    // fields are display-only — self-server.ts writes `127.0.0.1`/SERVER_IP purely
    // so the list reads truthfully, and every operation goes through
    // createHostExecutor, never a dial. Probing that display value reported the
    // control plane's own host as Offline: inside the api container `127.0.0.1:22`
    // is the CONTAINER's loopback, where there is no sshd.
    //
    // Same for a plain SSH row an operator added for THIS host (loopback / the
    // box's own address) — resolvesToLocalHost catches those too, so they don't
    // render the "Can't reach 127.0.0.1" banner for a box that is actually up.
    //
    // So answer with the channel ops actually use: the host SSH bridge when we're
    // containerized (host.docker.internal), else the same machine we're running on.
    if (await isLocalHostRow(server)) {
      const hostSsh = process.env.OPENSHIP_HOST_SSH_HOST?.trim();
      if (!hostSsh) {
        this.recordSuccess(serverId);
        return true;
      }
      const hostOk = await probeTcp(
        hostSsh,
        Number(process.env.OPENSHIP_HOST_SSH_PORT || 22),
        timeoutMs,
      );
      if (hostOk) this.recordSuccess(serverId);
      else this.recordFailure(serverId);
      return hostOk;
    }

    if (!server.sshHost) return false;

    const ok = await probeTcp(server.sshHost, server.sshPort ?? 22, timeoutMs);
    if (ok) this.recordSuccess(serverId);
    else this.recordFailure(serverId);
    return ok;
  }

  /**
   * Drop connection(s) immediately.
   *
   * @param serverId - drop a specific server connection.
   *   Omit to drop all connections.
   */
  invalidate(serverId?: string): void {
    // Explicit invalidation (settings changed / server deleted / shutdown) must
    // apply even to a retained connection — force the drop.
    if (serverId) {
      debugSsh(`invalidate server=${serverId}`);
      this.dropServer(serverId, true);
      // Config changed / explicit reset → give the breaker a fresh start.
      this.health.delete(serverId);
    } else {
      debugSsh("invalidate:all");
      for (const id of [...this.servers.keys()]) {
        this.dropServer(id, true);
      }
      this.health.clear();
    }
  }

  /**
   * Mark a connection as actively in use by a long-lived operation
   * (streaming, Docker tunnels, etc.).
   *
   * Pauses the idle timer so the connection isn't dropped mid-stream.
   * Must be paired with a `release()` call.
   */
  retain(serverId: string): void {
    const count = (this.retainCounts.get(serverId) ?? 0) + 1;
    this.retainCounts.set(serverId, count);
    // Pause idle timer while retained
    const conn = this.servers.get(serverId);
    if (conn?.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }
    debugSsh(`retain server=${serverId} count=${count}`);
  }

  /**
   * Release a long-lived hold on a connection.
   * When all holds are released, the idle timer restarts.
   */
  release(serverId: string): void {
    const count = Math.max(0, (this.retainCounts.get(serverId) ?? 0) - 1);
    if (count === 0) {
      this.retainCounts.delete(serverId);
      this.touchIdleTimer(serverId);
      // A local row borrows the shared host channel; when its last hold ends,
      // re-arm the OWNER's idle timer too. The owner's own timer was consumed and
      // skipped by the drop guard while this row was held, so without this the
      // channel would never be reclaimed after a long local-host op.
      if (this.localHostRows.has(serverId)) this.touchIdleTimer(HOST_CHANNEL_KEY);
    } else {
      this.retainCounts.set(serverId, count);
    }
    debugSsh(`release server=${serverId} count=${count}`);
  }

  /**
   * Shut the manager down for good and tear every cached connection down
   * CLEANLY — awaiting each executor's dispose rather than firing it and
   * forgetting (the idle/invalidate path). Two things depend on the await:
   *   - a system-ssh ControlMaster is a daemonized `ssh -fN` process that
   *     SURVIVES this process exiting; only its explicit `ssh -O exit`
   *     (inside dispose) reaps it, so we must let that run before we exit.
   *   - an ssh2 client gets to flush its disconnect instead of relying on the
   *     OS to close the socket out from under it.
   * Each dispose is bounded so a hung teardown can't outrun graceful shutdown.
   * Idempotent; no further acquire() calls are allowed afterwards.
   */
  async destroy(disposeTimeoutMs = 5_000): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    debugSsh("destroy");

    // Snapshot executors, then clear bookkeeping synchronously so nothing
    // re-touches a half-torn-down connection while disposes are in flight.
    const executors: CommandExecutor[] = [];
    for (const conn of this.servers.values()) {
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      if (conn.unsubDisconnect) {
        try { conn.unsubDisconnect(); } catch { /* best-effort */ }
      }
      executors.push(conn.executor);
    }
    this.servers.clear();
    this.retainCounts.clear();

    await Promise.allSettled(
      executors.map((exec) => this.disposeBounded(exec, disposeTimeoutMs)),
    );
  }

  /** Dispose an executor, resolving after `timeoutMs` even if it hangs. */
  private disposeBounded(exec: CommandExecutor, timeoutMs: number): Promise<void> {
    if (!("dispose" in exec) || typeof exec.dispose !== "function") return Promise.resolve();
    const disposed = Promise.resolve(exec.dispose()).catch(() => { /* teardown is best-effort */ });
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      if (typeof t.unref === "function") t.unref();
    });
    return Promise.race([disposed, timeout]);
  }

  // ── Connection lifecycle ───────────────────────────────────────────────

  /** Look up a server by ID and create a fresh executor. */
  private async connect(serverId: string): Promise<CommandExecutor> {
    const startedAt = Date.now();
    debugSsh(`connect:load-settings server=${serverId}`);

    const server = await repos.server.get(serverId);
    if (!server?.sshHost) {
      throw new Error("No server configured");
    }

    const sshConfig = await buildSshConfig(server);
    if (!sshConfig) {
      throw new Error("Invalid SSH auth configuration");
    }

    const executor = createExecutor(sshConfig);
    debugSsh(`connect:executor-prepared server=${serverId} (${formatDuration(startedAt)}) host=${sshConfig.host}`);
    return executor;
  }

  // ── Reliable-run (journaled) queue ───────────────────────────────────────

  /**
   * Process a server's op queue serially. Only one drain runs per server (the
   * `running` flag); ops appended mid-drain are picked up by the live loop.
   */
  private async drainQueue(serverId: string): Promise<void> {
    const q = this.queues.get(serverId);
    if (!q || q.running) return;
    q.running = true;
    try {
      while (q.ops.length > 0) {
        const op = q.ops[0];
        try {
          const result = await this.executeJournaledOp(serverId, op);
          q.ops.shift();
          op.resolve(result);
        } catch (err) {
          q.ops.shift();
          op.reject(err instanceof Error ? err : new Error(safeErrorMessage(err)));
        }
      }
    } finally {
      q.running = false;
      const cur = this.queues.get(serverId);
      if (cur && cur.ops.length === 0) this.queues.delete(serverId);
    }
  }

  /**
   * Drive one journaled op to a terminal result via the shared `runReliable`
   * core: reconnect-with-backoff across drops, re-driving the SAME opId so the
   * remote wrapper harvests instead of re-running (exactly-once). The manager
   * layers its pool + circuit breaker around it via the acquire/hooks.
   */
  private executeJournaledOp(serverId: string, op: QueuedOp): Promise<RunResult> {
    return runReliable(() => this.acquire(serverId), op.opId, op.command, {
      baseDir: OPENSHIP_DIR,
      timeoutMs: op.opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      waitSecs: op.opts.waitSecs,
      envPrefix: op.opts.envPrefix,
      reconnectMinMs: RECONNECT_MIN_MS,
      reconnectMaxMs: RECONNECT_MAX_MS,
      ensured: this.journalReady,
      onRetryableDrop: () => {
        this.dropServer(serverId);
        this.recordFailure(serverId);
      },
      onSuccess: () => this.recordSuccess(serverId),
    });
  }

  // ── Circuit-breaker ────────────────────────────────────────────────────

  /** Milliseconds remaining in this server's cooldown, or 0 if healthy. */
  private cooldownRemaining(serverId: string): number {
    const h = this.health.get(serverId);
    if (!h) return 0;
    return Math.max(0, h.unhealthyUntil - Date.now());
  }

  /** One success clears the breaker entirely. */
  private recordSuccess(serverId: string): void {
    if (this.health.has(serverId)) this.health.delete(serverId);
  }

  /** Count a connect/command failure; trip the breaker at the threshold and
   *  drop any cached (now-suspect) connection so the cooldown actually bites. */
  private recordFailure(serverId: string): void {
    const h = this.health.get(serverId) ?? { fails: 0, unhealthyUntil: 0 };
    h.fails += 1;
    if (h.fails >= FAIL_THRESHOLD) {
      h.unhealthyUntil = Date.now() + COOLDOWN_MS;
      this.dropServer(serverId);
      debugSsh(`circuit-open server=${serverId} fails=${h.fails} cooldown=${COOLDOWN_MS}ms`);
    }
    this.health.set(serverId, h);
  }

  // ── Idle timer ─────────────────────────────────────────────────────────

  private touchIdleTimer(serverId: string): void {
    const conn = this.servers.get(serverId);
    if (!conn) return;

    // Don't set idle timer while connection is retained by long-lived ops
    if ((this.retainCounts.get(serverId) ?? 0) > 0) return;

    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = setTimeout(() => {
      debugSsh(`idle-timeout:drop-connection server=${serverId}`);
      this.dropServer(serverId);
    }, this.opts.idleTimeoutMs);
    if (conn.idleTimer.unref) conn.idleTimer.unref();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Drop a cached connection.
   *
   * A connection that is RETAINED (held by a live long-lived consumer — an
   * interactive terminal or a metrics/Docker stream) is NOT dropped on the
   * non-forced path: a transient command failure, the circuit breaker, or a
   * `withExecutor` retry must never yank the shared SSH connection out from
   * under an active terminal (for the system-ssh path that means `ssh -O exit`
   * killing the ControlMaster and every session on it). Such a connection is
   * dropped once its consumers `release()`. Explicit invalidation (settings
   * change / server delete) passes `force` to drop it regardless.
   */
  private dropServer(serverId: string, force = false): void {
    const conn = this.servers.get(serverId);
    if (!conn) return;

    if (!force && (this.retainCounts.get(serverId) ?? 0) > 0) {
      debugSsh(`drop-server:skip-retained server=${serverId}`);
      return;
    }

    // The shared host channel outlives its own idle timer while ANY local row that
    // borrows it is still retained by a long-lived op — the deploy/stream holds the
    // ROW id, not this key, and its `retain` runs before the row's first `acquire`,
    // so propagating retain counts onto the owner is racy. Guarding at drop time
    // isn't; `release()` re-arms the timer so the channel is still reclaimed once
    // nothing holds it. `force` (invalidate/shutdown) always drops.
    if (!force && serverId === HOST_CHANNEL_KEY && this.anyLocalRowRetained()) {
      debugSsh("drop-server:skip-host-channel (a borrowing row is retained)");
      return;
    }

    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    if (conn.unsubDisconnect) {
      try { conn.unsubDisconnect(); } catch { /* best-effort */ }
    }
    this.retainCounts.delete(serverId);
    // A BORROWED entry (a local row pointing at the shared host channel) must only
    // be forgotten — disposing here would close the one host connection that every
    // other local row and `withHostExecutor` caller is still using.
    if (
      !conn.shared &&
      "dispose" in conn.executor &&
      typeof conn.executor.dispose === "function"
    ) {
      conn.executor.dispose();
    }
    this.servers.delete(serverId);
    if (conn.shared) this.localHostRows.delete(serverId);
    // Reclaiming the shared channel strands every borrow marker pointing at it —
    // forget them so `isConnected`/`probeReachable` don't report a dead channel and
    // the next `acquire` rebuilds cleanly. Markers are forgotten, never disposed.
    if (serverId === HOST_CHANNEL_KEY) this.forgetHostChannelBorrowers();
    debugSsh(`drop-server server=${serverId}${conn.shared ? " (borrowed, not disposed)" : ""}`);
  }

  /** A local row currently held by a long-lived op — see the host-channel drop guard. */
  private anyLocalRowRetained(): boolean {
    for (const id of this.localHostRows) {
      if ((this.retainCounts.get(id) ?? 0) > 0) return true;
    }
    return false;
  }

  /** Forget every borrow marker (never dispose — a marker doesn't own the executor)
   *  once the shared host channel is gone; the next acquire re-points them. */
  private forgetHostChannelBorrowers(): void {
    for (const id of [...this.localHostRows]) {
      const conn = this.servers.get(id);
      if (!conn?.shared) continue;
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      this.servers.delete(id);
      this.localHostRows.delete(id);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const sshManager = new SshConnectionManager();
