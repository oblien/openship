/**
 * Redis-backed CacheStore. Shares state across all replicas reading
 * the same REDIS_URL.
 *
 * Serialization: string values pass through (no overhead, ~80% of
 * caches hold tokens/IDs). Other types use JSON.
 *
 * Prefix invalidation: SCAN with COUNT 200 + UNLINK in batches of 500.
 * UNLINK is preferred over DEL — it's non-blocking on the Redis side
 * for large keysets. Iteration is bounded by SCAN's cursor protocol;
 * no risk of blocking the Redis event loop on a large keyspace.
 *
 * Connection reuse: the constructor takes an IORedis instance owned
 * by the factory (apps/api/src/lib/cache-store/index.ts). This way
 * multiple CacheStore namespaces share one connection.
 */

import type IORedis from "ioredis";
import type { CacheStore } from "./types";

const SCAN_BATCH = 200;
const UNLINK_BATCH = 500;

export class RedisCacheStore<T> implements CacheStore<T> {
  readonly name = "redis" as const;
  private readonly client: IORedis;
  private readonly namespace: string;

  constructor(client: IORedis, namespace: string) {
    this.client = client;
    this.namespace = namespace;
  }

  private fullKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private encode(value: T): string {
    return typeof value === "string" ? (value as unknown as string) : JSON.stringify(value);
  }

  private decode(raw: string): T {
    if (raw.length === 0) return raw as unknown as T;
    const first = raw.charCodeAt(0);
    const looksLikeJson =
      first === 0x7b /* { */ ||
      first === 0x5b /* [ */ ||
      first === 0x22 /* " */ ||
      raw === "null" ||
      raw === "true" ||
      raw === "false" ||
      (first >= 0x30 && first <= 0x39); /* 0-9 */
    if (!looksLikeJson) return raw as unknown as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async get(key: string): Promise<T | null> {
    const raw = await this.client.get(this.fullKey(key));
    if (raw === null) return null;
    return this.decode(raw);
  }

  async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(this.fullKey(key), this.encode(value), "EX", ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.unlink(this.fullKey(key));
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    const match = `${this.namespace}:${prefix}*`;
    let cursor = "0";
    const batch: string[] = [];
    do {
      const [next, keys] = await this.client.scan(cursor, "MATCH", match, "COUNT", SCAN_BATCH);
      cursor = next;
      for (const k of keys) {
        batch.push(k);
        if (batch.length >= UNLINK_BATCH) {
          await this.client.unlink(...batch);
          batch.length = 0;
        }
      }
    } while (cursor !== "0");
    if (batch.length > 0) {
      await this.client.unlink(...batch);
    }
  }

  async dispose(): Promise<void> {
    // Connection is owned by the factory; nothing to clean up per-store.
  }
}
