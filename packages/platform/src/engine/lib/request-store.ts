/**
 * Request-scoped memoization via AsyncLocalStorage.
 *
 * Some reads are expensive and idempotent *within a single inbound request* but
 * must stay fresh *across* requests — the canonical case is the Openship Cloud
 * session validation (`GET /api/cloud/account`), which a single `/github/status`
 * fans out into ~6 times (auth-mode resolution + one per cloudClient call). The
 * existing single-flight only collapses *concurrent* calls; sequential awaits
 * within one handler each start a fresh flight, so the same request hammers the
 * SaaS.
 *
 * `requestMemo` fixes that without a cross-request cache: the result is shared
 * for the lifetime of ONE request and discarded when it ends (the Map dies with
 * the AsyncLocalStorage frame). A new request gets a fresh store → still
 * validates live. Outside a request (cron, boot, background jobs) there is no
 * store and `requestMemo` simply calls the factory — no memoization, no leak.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type RequestStore = Map<string, Promise<unknown>>;

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Run `fn` inside a fresh per-request memo store. Seed this ONCE in a global
 * middleware so every downstream await shares the same store.
 */
export function runWithRequestStore<T>(fn: () => T): T {
  return storage.run(new Map(), fn);
}

/**
 * Memoize an async result for the duration of the current request. Repeated
 * calls with the same `key` within one request share a single promise (in-flight
 * or settled); a new request starts empty. With no active request store, falls
 * through to `factory()` unmemoized.
 *
 * The promise is cached as-is — a rejection is shared too, so a transient
 * failure won't be retried within the same request (acceptable: the next
 * request re-attempts fresh).
 */
export function requestMemo<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store) return factory();
  const existing = store.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = factory();
  store.set(key, p);
  return p;
}
