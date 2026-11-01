import { observedAllSettled } from "@repo/core/diagnostics";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import type { Driver } from "./connection";

export interface AdvisoryLockHandle {
  release(): Promise<void>;
}

interface LockSession {
  client: PoolClient;
  tails: Map<number, Promise<void>>;
  error?: Error;
}

interface LockFrame {
  session: LockSession;
  keys: ReadonlySet<number>;
  children: Set<Promise<unknown>>;
  active: boolean;
}

export function hashStringToInt(input: string): number {
  // FNV-1a 32-bit, masked to 31 bits so it fits a signed int4 and stays
  // consistent across drivers that don't auto-cast unsigned.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h & 0x7fffffff;
}

/** Admission counters and waiters belong to the connection that owns the locks. */
export function createAdvisoryLocks(options: {
  getDriver(): Driver;
  getPgPool(): Pool;
  poolMax?: number;
}) {
  const { getDriver, getPgPool } = options;
  const currentFrame = new AsyncLocalStorage<LockFrame>();

  /**
   * Long-lived session locks use the same pg Pool as Drizzle. Without a separate
   * admission limit, `pool.max` concurrent locks can each enter a callback that
   * then waits forever for one more connection. Keep one pool slot reserved for
   * ordinary queries. Nested callback locks share their parent's connection and
   * permit; otherwise every admitted quota check can stall waiting for a second
   * permit to verify billing. PGlite never enters this gate.
   */
  const MAX_POSTGRES_LOCK_CLIENTS = Math.max(1, (options.poolMax ?? 20) - 1);
  let postgresLockClients = 0;
  const permitWaiters: Array<(release: () => void) => void> = [];

  function acquirePostgresLockPermit(): Promise<() => void> {
    if (postgresLockClients < MAX_POSTGRES_LOCK_CLIENTS) {
      postgresLockClients++;
      return Promise.resolve(createPermitRelease());
    }
    return new Promise((resolve) => permitWaiters.push(resolve));
  }

  function tryAcquirePostgresLockPermit(): (() => void) | null {
    if (postgresLockClients >= MAX_POSTGRES_LOCK_CLIENTS) return null;
    postgresLockClients++;
    return createPermitRelease();
  }

  function createPermitRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = permitWaiters.shift();
      if (next) {
        next(createPermitRelease());
      } else {
        postgresLockClients--;
      }
    };
  }

  function errorForPool(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }

  function runInSession<T>(
    session: LockSession,
    parent: LockFrame | undefined,
    scopeKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = hashStringToInt(scopeKey);
    const inherited = parent?.keys.has(key) ?? false;
    const run = async () => {
      if (session.error) throw session.error;
      if (!inherited) {
        try {
          await session.client.query("SELECT pg_advisory_lock($1)", [key]);
        } catch (err) {
          session.error = errorForPool(err);
          throw err;
        }
      }
      const frame: LockFrame = {
        session,
        keys: new Set([...(parent?.keys ?? []), key]),
        children: new Set(),
        active: true,
      };
      try {
        return await currentFrame.run(frame, fn);
      } finally {
        frame.active = false;
        // Promise.all can reject while another nested callback is still running.
        // Keep its ancestor locks and connection until every started child exits.
        await observedAllSettled(frame.children, "db/advisory-lock-factory");
        if (!inherited) {
          try {
            const result = await session.client.query<{ pg_advisory_unlock: boolean }>(
              "SELECT pg_advisory_unlock($1)", [key],
            );
            if (result.rows[0]?.pg_advisory_unlock !== true) {
              throw new Error(`Postgres advisory lock ${scopeKey} was not owned during release`);
            }
          } catch (err) {
            session.error = errorForPool(err);
            throw err;
          }
        }
      }
    };

    // Postgres session locks are reentrant. Parallel siblings are not nested
    // owners of each other's key, so serialize those callbacks explicitly.
    const result = inherited ? run() : (session.tails.get(key) ?? Promise.resolve()).then(run);
    if (!inherited) {
      const tail = result.then(() => {}, () => {
      /* diagnostics-ignore: The original result is returned to the caller; this branch only releases queue bookkeeping. */
});
      session.tails.set(key, tail);
      void tail.then(() => {
        if (session.tails.get(key) === tail) session.tails.delete(key);
      });
    }
    if (parent) {
      parent.children.add(result);
      void result.then(
        () => parent.children.delete(result),
        () => { /* diagnostics-ignore: The original result is returned to the caller; this branch only releases queue bookkeeping. */ return parent.children.delete(result); },
      );
    }
    return result;
  }

  /**
   * 31-bit signed-positive int hash of a string identity, for Postgres advisory
   * lock keys. `pg_advisory_lock` takes a bigint; hashing a string identity down
   * to one keys the lock by identity, not by row presence. Collisions just make
   * two unrelated keys serialize (correctness preserved); 31 bits ≈ 2B buckets,
   * so collision risk is negligible.
   */


  /**
   * Run `fn` while holding a Postgres SESSION-level advisory lock keyed by
   * `scopeKey`, serializing it across every process/replica sharing the database.
   * The outer callback owns one pooled connection; awaited nested callbacks use
   * that same session. Each scope is unlocked in `finally` (session-level, not
   * xact-scoped, because callers may run long — e.g. provisioning a server).
   *
   * On the PGlite driver (single embedded process — desktop/dev) there is nothing
   * to coordinate across processes, so this is a passthrough; callers still layer
   * an in-process mutex on top for same-process serialization.
   */
  async function withAdvisoryLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    if (getDriver() === "pglite") {
      return fn();
    }

    const parent = currentFrame.getStore();
    if (parent?.active) return runInSession(parent.session, parent, scopeKey, fn);

    const releasePermit = await acquirePostgresLockPermit();
    let client;
    try {
      client = await getPgPool().connect();
    } catch (err) {
      releasePermit();
      throw err;
    }
    const session: LockSession = { client, tails: new Map() };
    try {
      const result = await runInSession(session, undefined, scopeKey, fn);
      if (session.error) throw session.error;
      return result;
    } finally {
      client.release(session.error);
      releasePermit();
    }
  }

  /**
   * Try to acquire a session-level advisory lock without waiting. The returned
   * handle owns its pooled connection until release, so callers can hold the lock
   * across lifecycles that outlive a single awaited function (for example SSE).
   */
  async function tryAcquireAdvisoryLock(scopeKey: string): Promise<AdvisoryLockHandle | null> {
    if (getDriver() === "pglite") {
      return { release: async () => {} };
    }

    const releasePermit = tryAcquirePostgresLockPermit();
    if (!releasePermit) return null;
    const key = hashStringToInt(scopeKey);
    let client;
    try {
      client = await getPgPool().connect();
    } catch (err) {
      releasePermit();
      throw err;
    }
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [key],
      );
      if (result.rows[0]?.acquired !== true) {
        client.release();
        releasePermit();
        return null;
      }
    } catch (err) {
      client.release(errorForPool(err));
      releasePermit();
      throw err;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          const result = await client.query<{ pg_advisory_unlock: boolean }>(
            "SELECT pg_advisory_unlock($1)",
            [key],
          );
          if (result.rows[0]?.pg_advisory_unlock !== true) {
            throw new Error(`Postgres advisory lock ${scopeKey} was not owned during release`);
          }
        } catch (err) {
          client.release(errorForPool(err));
          releasePermit();
          throw err;
        }
        client.release();
        releasePermit();
      },
    };
  }
  /** A detached worker must acquire its own lock session. Inheriting its
   * request's session can hold an admission lock until the entire worker exits. */
  function runOutsideAdvisoryLock<T>(work: () => T): T {
    return currentFrame.exit(work);
  }

  return Object.freeze({ withAdvisoryLock, tryAcquireAdvisoryLock, runOutsideAdvisoryLock });
}
