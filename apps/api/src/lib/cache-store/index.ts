/**
 * CacheStore factory + module-scoped Redis connection.
 *
 * Mirrors the job-runner pattern: probe Redis once, share the
 * decision + connection across all callers in this process.
 *
 *   await cacheStore<string>("gh-tokens", { maxSize: 5000 })
 *
 * Returns a Redis-backed store when REDIS_URL is reachable; a
 * MemoryCacheStore otherwise. Self-hosted PGlite installs never run
 * Redis and always get the memory backend — no behavioral change vs
 * the legacy TtlCache they had before.
 *
 * Override with `OPENSHIP_CACHE_STORE=memory` or `=redis` to force a
 * backend (handy for tests, and for production deployments that want
 * to opt out of Redis even when REDIS_URL is set).
 */

import IORedis from "ioredis";
import { env, REDIS_REQUIRED } from "../../config/env";
import { isRedisReachable } from "../../lib/redis";
import { MemoryCacheStore } from "./memory";
import { RedisCacheStore } from "./redis";
import type { CacheStore, CacheStoreOptions } from "./types";

export type { CacheStore, CacheStoreOptions } from "./types";

type Backend = "redis" | "memory";

let backendDecision: Backend | null = null;
let resolvingPromise: Promise<Backend> | null = null;
let sharedRedis: IORedis | null = null;
const trackedStores = new Set<CacheStore<unknown>>();

/**
 * Memoize stores by namespace so two call sites with the same name
 * share one store. Without this, `await cacheStore("foo")` in
 * different files would each get a fresh MemoryCacheStore on memory
 * mode → cached entries invisible to siblings. Idempotency is what
 * makes the await-at-use-site pattern correct.
 */
const storesByNamespace = new Map<string, Promise<CacheStore<unknown>>>();

async function pickBackend(): Promise<Backend> {
  const override = (process.env.OPENSHIP_CACHE_STORE ?? "").toLowerCase().trim();
  if (override === "memory") return "memory";
  if (override === "redis") return "redis";
  // Redis required (CLOUD_MODE / OPENSHIP_REQUIRE_REDIS): force redis, skip the
  // probe — no silent per-replica memory cache that would drift across instances.
  if (REDIS_REQUIRED) return "redis";
  return (await isRedisReachable()) ? "redis" : "memory";
}

async function resolveBackend(): Promise<Backend> {
  if (backendDecision) return backendDecision;
  if (resolvingPromise) return resolvingPromise;
  resolvingPromise = (async () => {
    const choice = await pickBackend();
    backendDecision = choice;
    resolvingPromise = null;
    return choice;
  })();
  return resolvingPromise;
}

function getSharedRedis(): IORedis {
  if (sharedRedis) return sharedRedis;
  sharedRedis = new IORedis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  sharedRedis.on("error", (err) => {
    console.warn("[cache-store:redis] connection error:", err.message);
  });
  return sharedRedis;
}

/**
 * Get the CacheStore for `namespace`. Idempotent — two call sites
 * with the same name share one store (so memory-mode entries are
 * visible across consumers, matching Redis-mode semantics). Use
 * directly at call site:
 *
 *   const store = await cacheStore<TokenCache>("oblien-ns-tokens");
 *   await store.set(userId, token, 1500);
 */
export function cacheStore<T>(
  namespace: string,
  opts: CacheStoreOptions = {},
): Promise<CacheStore<T>> {
  if (!namespace || namespace.includes(" ")) {
    throw new Error(`cacheStore: invalid namespace "${namespace}"`);
  }
  const existing = storesByNamespace.get(namespace);
  if (existing) return existing as Promise<CacheStore<T>>;
  const promise = (async () => {
    const backend = await resolveBackend();
    const store: CacheStore<T> =
      backend === "redis"
        ? new RedisCacheStore<T>(getSharedRedis(), namespace)
        : new MemoryCacheStore<T>(opts);
    trackedStores.add(store as CacheStore<unknown>);
    return store;
  })();
  storesByNamespace.set(namespace, promise as Promise<CacheStore<unknown>>);
  return promise;
}

/** Active backend choice — null if no store has been created yet. */
export function describeCacheStore(): Backend | null {
  return backendDecision;
}

/** Graceful shutdown — disposes every tracked store and closes the
 *  shared Redis connection. Idempotent. */
export async function shutdownCacheStores(): Promise<void> {
  for (const store of trackedStores) {
    try {
      await store.dispose();
    } catch {
      // best-effort
    }
  }
  trackedStores.clear();
  storesByNamespace.clear();
  if (sharedRedis) {
    try {
      sharedRedis.disconnect();
    } catch {
      // best-effort
    }
    sharedRedis = null;
  }
  backendDecision = null;
}
