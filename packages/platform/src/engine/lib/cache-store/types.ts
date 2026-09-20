/**
 * CacheStore<T> — pluggable TTL cache abstraction.
 *
 * Two interchangeable backends:
 *
 *   "redis"   Shared across replicas via Redis SETEX + SCAN. Used when
 *             REDIS_URL is reachable. Survives process restart, keeps
 *             multi-replica deployments consistent.
 *
 *   "memory"  Process-local TtlCache wrapper. Used as the fallback for
 *             self-hosted / desktop / dev. Loses state on restart,
 *             which is fine for token/installation caches that
 *             self-heal via cache-miss → re-fetch.
 *
 * Every caller (GitHub token cache, future session caches, etc.) talks
 * to the interface — none knows which backend is live. The probe +
 * selection happens once at first `cacheStore` call, mirroring
 * the job-runner module pattern.
 *
 * Keys are namespaced by the `namespace` arg at create time so two
 * unrelated caches (github tokens, oauth sessions) cannot collide on
 * shared Redis. Memory mode uses one TtlCache per namespace.
 */

export interface CacheStore<T> {
  readonly name: "redis" | "memory";

  /** Get a value. Returns null if missing or expired. */
  get(key: string): Promise<T | null>;

  /** Set a value with a TTL in seconds. */
  set(key: string, value: T, ttlSeconds: number): Promise<void>;

  /** Delete one key. No-op if missing. */
  delete(key: string): Promise<void>;

  /**
   * Delete every key with the given prefix. The namespace prefix is
   * NOT included — pass the application-level prefix (e.g. `"inst:user:abc:"`).
   *
   * Redis uses SCAN + UNLINK; memory uses Map iteration. Both are
   * safe to call repeatedly.
   */
  invalidateByPrefix(prefix: string): Promise<void>;

  /** Stop background timers / close Redis connections. Idempotent. */
  dispose(): Promise<void>;
}

export interface CacheStoreOptions {
  /** Maximum entries before eviction (memory backend only). Default 5000. */
  maxSize?: number;
  /** Memory sweep interval in ms. 0 disables. Default 60000. */
  sweepIntervalMs?: number;
}
