/**
 * Provisioning lock — serializes server/workspace-scoped provisioning across
 * concurrent deploys so they never race the target's shared state (apt/dpkg,
 * the openresty unit + config, docker networks, the setup-state file).
 *
 * Two layers:
 *   A. An in-process keyed async-mutex (module singleton) — serializes callers
 *      in THIS process by scopeKey, and collapses N same-process waiters into a
 *      single downstream waiter. Correct on its own for single-process deploys.
 *   B. A Postgres session-level advisory lock (via @repo/db) — serializes across
 *      processes/replicas that share the database. On PGlite (single embedded
 *      process) it's a passthrough; layer A already covers that case.
 *
 * Because the advisory lock runs INSIDE the mutex, at most one caller per process
 * ever waits on it — so at most (#replicas) DB connections are ever blocked on a
 * given scope, well under the pool ceiling even under heavy deploy fan-out.
 */

import { withAdvisoryLock } from "@repo/db";
import type { ProvisionLock } from "@repo/adapters";

/** Tail of the in-flight chain per scopeKey. Each tail always resolves. */
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier call for the same `scopeKey` has finished — an
 * in-process mutex keyed by scope. Different scopeKeys never block each other.
 */
export function withKeyedMutex<T>(
  scopeKey: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const prev = tails.get(scopeKey) ?? Promise.resolve();
  // prev always resolves (tails never reject), so fn runs after prev settles.
  let started = false;
  const result = prev.then(() => {
    started = true;
    if (signal?.aborted) throw new Error("Deployment cancelled while waiting for provisioning lock");
    return fn();
  });
  // The chain tail swallows errors so a throwing fn never blocks later callers.
  const tail = result.then(
    () => {},
    () => {},
  );
  tails.set(scopeKey, tail);
  // Drop the entry once idle so the map doesn't grow unbounded.
  void tail.then(() => {
    if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
  });
  if (!signal) return result;

  // A waiter may leave immediately when cancelled, but a critical section that
  // already started must be allowed to settle. Returning early from a running
  // section would let a replacement deploy race its Docker/edge mutations. The
  // queued tail still performs the same abort check, so it becomes a no-op when
  // the cancelled waiter eventually reaches the head.
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (started || settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Deployment cancelled while waiting for provisioning lock"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    result.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Create a lock scoped to one server or workspace. Pass `run(fn)` the racy
 * critical section; concurrent deploys sharing the scope serialize on it.
 */
export function createProvisionLock(scopeKey: string): ProvisionLock {
  return {
    run: <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
      withKeyedMutex(scopeKey, () => withAdvisoryLock(scopeKey, fn), signal),
  };
}
