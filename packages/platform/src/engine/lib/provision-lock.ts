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

import { withAdvisoryLock, tryAcquireAdvisoryLock } from "@repo/db";
import type { ProvisionLock } from "@repo/adapters";
import { withKeyedMutex, tryWithKeyedMutex } from "@repo/core";
export { withKeyedMutex } from "@repo/core";

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

/** Recovery must not queue behind a live worker and mistake its eventual exit
 * for a crashed owner. Try both lock layers, leaving active work untouched. */
export async function tryWithProvisionLock<T>(scopeKey: string, work: () => Promise<T>): Promise<T | undefined> {
  return tryWithKeyedMutex(scopeKey, async () => {
    const lock = await tryAcquireAdvisoryLock(scopeKey);
    if (!lock) return undefined;
    try { return await work(); }
    finally { await lock.release(); }
  });
}
