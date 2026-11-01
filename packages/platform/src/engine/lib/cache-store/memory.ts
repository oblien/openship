/**
 * In-memory CacheStore backend. Thin async wrapper over TtlCache.
 *
 * Used as the fallback when Redis is unreachable, and as the
 * permanent backend for self-hosted PGlite installs that never run
 * Redis. Loses state on restart — every consumer of CacheStore is
 * expected to be self-healing on cache miss.
 */

import { TtlCache } from "../cache";
import type { CacheStore, CacheStoreOptions } from "./types";

export class MemoryCacheStore<T> implements CacheStore<T> {
  readonly name = "memory" as const;
  private readonly inner: TtlCache<T>;

  constructor(opts: CacheStoreOptions = {}) {
    this.inner = new TtlCache<T>({
      maxSize: opts.maxSize ?? 5_000,
      sweepIntervalMs: opts.sweepIntervalMs ?? 60_000,
    });
  }

  async get(key: string): Promise<T | null> {
    return this.inner.get(key);
  }

  async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.inner.set(key, value, ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    this.inner.delete(key);
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    this.inner.invalidateByPrefix(prefix);
  }

  async dispose(): Promise<void> {
    this.inner.dispose();
  }
}
