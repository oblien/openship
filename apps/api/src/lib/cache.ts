/**
 * TtlCache — generic in-memory cache with automatic TTL expiration.
 *
 * Entries are lazily evicted on read and periodically swept via a
 * background timer (default: every 60 s). Supports per-key TTL,
 * prefix-based invalidation, and a hard size cap.
 *
 * Usage:
 *   const cache = new TtlCache<string>({ maxSize: 1000, sweepIntervalMs: 60_000 });
 *   cache.set("key", "value", 300);   // 300 seconds TTL
 *   cache.get("key");                  // "value" | null
 *   cache.invalidateByPrefix("user:"); // remove all keys starting with "user:"
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** Maximum number of entries before oldest are evicted (default: 5000). */
  maxSize?: number;
  /** Interval in ms for the background sweep timer (default: 60000). 0 = disabled. */
  sweepIntervalMs?: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TtlCacheOptions = {}) {
    this.maxSize = opts.maxSize ?? 5_000;
    const sweepMs = opts.sweepIntervalMs ?? 60_000;

    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
      /* Allow the process to exit even if the timer is running */
      if (this.sweepTimer && typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
        this.sweepTimer.unref();
      }
    }
  }

  /** Get a value, returning null if missing or expired. */
  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Set a value with a TTL in seconds. */
  set(key: string, value: T, ttlSeconds: number): void {
    if (this.store.size >= this.maxSize) {
      this.sweep();
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
  }

  /** Check if a key exists and is not expired. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Delete a specific key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all keys that start with the given prefix. */
  invalidateByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** Invalidate all keys that contain the given substring. */
  invalidateBySubstring(sub: string): void {
    for (const key of this.store.keys()) {
      if (key.includes(sub)) this.store.delete(key);
    }
  }

  /** Remove all expired entries. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  /** Clear all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Current number of entries (including possibly expired). */
  get size(): number {
    return this.store.size;
  }

  /** Iterate over all non-expired values. */
  *values(): IterableIterator<T> {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      } else {
        yield entry.value;
      }
    }
  }

  /** Stop the background sweep timer (for graceful shutdown / tests). */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
