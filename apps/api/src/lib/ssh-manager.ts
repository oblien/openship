/**
 * SSH Connection Manager — cached executor with idle-TTL + optional
 * persistent (always-on) mode with automatic reconnection.
 *
 * All server interactions go through `sshManager.acquire()` or the
 * convenience wrapper `sshManager.withExecutor(fn)`.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Cached mode (default)                                          │
 * │  ─────────────────────                                          │
 * │  Connection created on first acquire(). Each acquire() resets   │
 * │  an idle timer. After idleTimeoutMs with no usage, the          │
 * │  connection drops silently. Next acquire() reconnects from      │
 * │  fresh DB settings.                                             │
 * │                                                                 │
 * │  Persistent mode                                                │
 * │  ───────────────                                                │
 * │  Connection stays alive. Health-check pings run on an interval. │
 * │  On disconnect, automatic retry up to maxRetries. Idle timer    │
 * │  is disabled.                                                   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Invalidation:
 *   Call sshManager.invalidate() when server settings change or the
 *   server is deleted. The current connection drops immediately and
 *   the next acquire() builds a fresh executor from updated settings.
 *
 * Retry on error:
 *   withExecutor(fn) catches connection-level errors, invalidates,
 *   and retries fn once with a fresh executor. This handles stale
 *   connections transparently.
 *
 * Security:
 *   - SSH credentials are read from DB on each connect(), never cached
 *     in memory beyond the ssh2 client's internal state.
 *   - Idle timeout ensures connections don't linger when unused.
 *   - Timers use unref() so they don't prevent graceful shutdown.
 */

import { repos } from "@repo/db";
import {
  createExecutor,
  isRetryableRemoteConnectionError,
  type CommandExecutor,
  type SshConfig,
} from "@repo/adapters";
import { formatDuration, systemDebug } from "@/lib/system-debug";

function debugSsh(message: string): void {
  systemDebug("ssh-manager", message);
}

// ─── Options ─────────────────────────────────────────────────────────────────

interface SshManagerOptions {
  /** Idle timeout before dropping a cached connection (default: 5 min) */
  idleTimeoutMs?: number;
  /** Health-check interval in persistent mode (default: 30s) */
  healthIntervalMs?: number;
  /** Delay before retrying in persistent mode (default: 5s) */
  retryDelayMs?: number;
  /** Max consecutive retries in persistent mode before giving up (default: 10) */
  maxRetries?: number;
}

const DEFAULTS = {
  idleTimeoutMs: 5 * 60_000,
  healthIntervalMs: 30_000,
  retryDelayMs: 5_000,
  maxRetries: 10,
} as const;

// ─── Connection errors ───────────────────────────────────────────────────────

// ─── Manager ─────────────────────────────────────────────────────────────────

export class SshConnectionManager {
  private executor: CommandExecutor | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private connecting: Promise<CommandExecutor> | null = null;
  private persistent = false;
  private retryCount = 0;
  private destroyed = false;
  private readonly opts: Required<SshManagerOptions>;

  constructor(options?: SshManagerOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Get the shared executor. Creates/reconnects as needed.
   * Resets the idle timer on every call.
   *
   * Throws if no server is configured or auth is invalid.
   */
  async acquire(): Promise<CommandExecutor> {
    const startedAt = Date.now();
    if (this.destroyed) throw new Error("SshManager has been destroyed");

    this.touchIdleTimer();

    if (this.executor) {
      debugSsh(`acquire:reuse (${formatDuration(startedAt)})`);
      return this.executor;
    }

    // Dedup concurrent acquire() calls — only one connect() in flight
    if (this.connecting) {
      debugSsh("acquire:join-existing-connect");
      return this.connecting;
    }

    debugSsh("acquire:connect-start");
    this.connecting = this.connect();
    try {
      const exec = await this.connecting;
      this.executor = exec;
      this.retryCount = 0;

      if (this.persistent) this.startHealthCheck();

      debugSsh(`acquire:executor-ready (${formatDuration(startedAt)})`);
      return exec;
    } catch (err) {
      this.executor = null;
      const msg = err instanceof Error ? err.message : String(err);
      debugSsh(`acquire:failed (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    } finally {
      this.connecting = null;
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
    fn: (executor: CommandExecutor) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const executor = await this.acquire();
    try {
      const result = await fn(executor);
      debugSsh(`withExecutor:done (${formatDuration(startedAt)})`);
      return result;
    } catch (err) {
      if (isRetryableRemoteConnectionError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        debugSsh(`withExecutor:retry-after-connection-error ${msg}`);
        this.dropExecutor();
        const freshExecutor = await this.acquire();
        const result = await fn(freshExecutor);
        debugSsh(`withExecutor:retry-done (${formatDuration(startedAt)})`);
        return result;
      }
      const msg = err instanceof Error ? err.message : String(err);
      debugSsh(`withExecutor:failed (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    }
  }

  /**
   * Enable or disable persistent (always-on) mode.
   *
   * Persistent mode disables the idle timer and starts health-check
   * pings. On disconnect, it retries automatically.
   */
  setPersistent(enabled: boolean): void {
    this.persistent = enabled;
    debugSsh(`persistent:${enabled ? "enabled" : "disabled"}`);
    if (enabled) {
      this.clearIdleTimer();
      if (this.executor) this.startHealthCheck();
    } else {
      this.stopHealthCheck();
      this.touchIdleTimer();
    }
  }

  /** Whether persistent mode is active. */
  get isPersistent(): boolean {
    return this.persistent;
  }

  /** Whether there's an active connection right now. */
  get isConnected(): boolean {
    return this.executor !== null;
  }

  /**
   * Drop the current connection immediately.
   *
   * Next acquire() reconnects from fresh DB settings.
   * Call this when server settings change or server is deleted.
   */
  invalidate(): void {
    debugSsh("invalidate");
    this.dropConnection();
    this.retryCount = 0;
  }

  /** Shut down the manager. No further acquire() calls allowed. */
  destroy(): void {
    this.destroyed = true;
    debugSsh("destroy");
    this.dropConnection();
  }

  // ── Connection lifecycle ───────────────────────────────────────────────

  /** Build SshConfig from DB settings and create a fresh executor. */
  private async connect(): Promise<CommandExecutor> {
    const startedAt = Date.now();
    debugSsh("connect:load-settings");
    const settings = await repos.instanceSettings.get();
    if (!settings?.sshHost) {
      throw new Error("No server configured");
    }

    const sshConfig = await this.buildSshConfig(settings);
    if (!sshConfig) {
      throw new Error("Invalid SSH auth configuration");
    }

    const executor = createExecutor(sshConfig);
    debugSsh(`connect:executor-prepared (${formatDuration(startedAt)}) host=${sshConfig.host}`);
    return executor;
  }

  /** Map DB row → SshConfig. Returns null if auth is incomplete. */
  private async buildSshConfig(settings: {
    sshHost: string | null;
    sshPort?: number | null;
    sshUser?: string | null;
    sshAuthMethod?: string | null;
    sshPassword?: string | null;
    sshKeyPath?: string | null;
    sshKeyPassphrase?: string | null;
  }): Promise<SshConfig | null> {
    if (!settings.sshHost) return null;

    const config: SshConfig = {
      host: settings.sshHost,
      port: settings.sshPort ?? 22,
      username: settings.sshUser ?? "root",
    };

    if (settings.sshAuthMethod === "password" && settings.sshPassword) {
      config.password = settings.sshPassword;
    } else if (settings.sshAuthMethod === "key" && settings.sshKeyPath) {
      const { readFileSync } = await import("node:fs");
      try {
        config.privateKey = readFileSync(settings.sshKeyPath, "utf-8");
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

  // ── Idle timer (cached mode) ───────────────────────────────────────────

  private touchIdleTimer(): void {
    if (this.persistent) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      debugSsh("idle-timeout:drop-connection");
      this.dropConnection();
    }, this.opts.idleTimeoutMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── Health check (persistent mode) ─────────────────────────────────────

  private startHealthCheck(): void {
    this.stopHealthCheck();
    debugSsh(`health-check:start interval=${this.opts.healthIntervalMs}ms`);
    this.healthTimer = setInterval(async () => {
      if (!this.executor) return;
      try {
        await this.executor.exec("echo 1", { timeout: 10_000 });
        this.retryCount = 0;
        debugSsh("health-check:ok");
      } catch {
        debugSsh("health-check:failed");
        await this.handleDisconnect();
      }
    }, this.opts.healthIntervalMs);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      debugSsh("health-check:stop");
    }
  }

  /** Called when a health check fails in persistent mode. */
  private async handleDisconnect(): Promise<void> {
    debugSsh("disconnect:handling");
    this.dropExecutor();

    if (!this.persistent || this.destroyed) return;
    if (this.retryCount >= this.opts.maxRetries) return;

    this.retryCount++;
    debugSsh(`disconnect:retry ${this.retryCount}/${this.opts.maxRetries}`);

    await new Promise((r) => {
      const t = setTimeout(r, this.opts.retryDelayMs);
      if (t.unref) t.unref();
    });

    if (this.destroyed || !this.persistent) return;

    try {
      await this.acquire();
      debugSsh("disconnect:reconnected");
    } catch {
      debugSsh("disconnect:reconnect-failed");
      // acquire() failed — next health tick will retry
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  private dropConnection(): void {
    debugSsh("drop-connection");
    this.clearIdleTimer();
    this.stopHealthCheck();
    this.dropExecutor();
  }

  private dropExecutor(): void {
    if (this.executor) {
      const exec = this.executor;
      this.executor = null;
      if ("dispose" in exec && typeof exec.dispose === "function") {
        exec.dispose();
      }
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const sshManager = new SshConnectionManager();
