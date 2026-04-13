/**
 * SSH Connection Manager — per-server cached executors with idle-TTL.
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

import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { repos } from "@repo/db";
import {
  createExecutor,
  isRetryableRemoteConnectionError,
  type CommandExecutor,
  type SshConfig,
} from "@repo/adapters";
import { formatDuration, systemDebug } from "@/lib/system-debug";

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

  if (settings.sshAuthMethod === "password" && settings.sshPassword) {
    config.password = settings.sshPassword;
  } else if (settings.sshAuthMethod === "key" && settings.sshKeyPath) {
    const keyPath = settings.sshKeyPath.trim();
    // Reject path traversal — must be absolute with no ".." segments
    if (!isAbsolute(keyPath) || keyPath.includes("..")) return null;

    try {
      config.privateKey = readFileSync(keyPath, "utf-8");
    } catch {
      return null;
    }
    if (settings.sshKeyPassphrase) {
      config.privateKeyPassphrase = settings.sshKeyPassphrase;
    }
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

// ─── Per-server connection state ─────────────────────────────────────────────

interface ServerConnection {
  executor: CommandExecutor;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class SshConnectionManager {
  private servers = new Map<string, ServerConnection>();
  private connecting = new Map<string, Promise<CommandExecutor>>();
  private retainCounts = new Map<string, number>();
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

    const cached = this.servers.get(serverId);
    if (cached) {
      this.touchIdleTimer(serverId);
      debugSsh(`acquire:reuse server=${serverId} (${formatDuration(startedAt)})`);
      return cached.executor;
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
      this.servers.set(serverId, { executor: exec, idleTimer: null });
      this.touchIdleTimer(serverId);
      debugSsh(`acquire:executor-ready server=${serverId} (${formatDuration(startedAt)})`);
      return exec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
   */
  async withExecutor<T>(
    serverId: string,
    fn: (executor: CommandExecutor) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const executor = await this.acquire(serverId);
    try {
      const result = await fn(executor);
      debugSsh(`withExecutor:done server=${serverId} (${formatDuration(startedAt)})`);
      return result;
    } catch (err) {
      if (isRetryableRemoteConnectionError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        debugSsh(`withExecutor:retry-after-connection-error server=${serverId} ${msg}`);
        this.dropServer(serverId);
        const freshExecutor = await this.acquire(serverId);
        const result = await fn(freshExecutor);
        debugSsh(`withExecutor:retry-done server=${serverId} (${formatDuration(startedAt)})`);
        return result;
      }
      const msg = err instanceof Error ? err.message : String(err);
      debugSsh(`withExecutor:failed server=${serverId} (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    }
  }

  /** Whether there's an active connection for a given server. */
  isConnected(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  /**
   * Drop connection(s) immediately.
   *
   * @param serverId — drop a specific server connection.
   *   Omit to drop all connections.
   */
  invalidate(serverId?: string): void {
    if (serverId) {
      debugSsh(`invalidate server=${serverId}`);
      this.dropServer(serverId);
    } else {
      debugSsh("invalidate:all");
      for (const id of [...this.servers.keys()]) {
        this.dropServer(id);
      }
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
    } else {
      this.retainCounts.set(serverId, count);
    }
    debugSsh(`release server=${serverId} count=${count}`);
  }

  /** Shut down the manager. No further acquire() calls allowed. */
  destroy(): void {
    this.destroyed = true;
    debugSsh("destroy");
    this.invalidate();
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

  private dropServer(serverId: string): void {
    const conn = this.servers.get(serverId);
    if (!conn) return;

    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    this.retainCounts.delete(serverId);
    if ("dispose" in conn.executor && typeof conn.executor.dispose === "function") {
      conn.executor.dispose();
    }
    this.servers.delete(serverId);
    debugSsh(`drop-server server=${serverId}`);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const sshManager = new SshConnectionManager();
