import { getDriver, getPgPool, PG_POOL_MAX } from "./client";

export interface AdvisoryLockHandle {
  release(): Promise<void>;
}

/**
 * Long-lived session locks use the same pg Pool as Drizzle. Without a separate
 * admission limit, `pool.max` concurrent locks can each enter a callback that
 * then waits forever for one more connection. Keep one pool slot reserved for
 * ordinary queries. PGlite never enters this gate.
 */
const MAX_POSTGRES_LOCK_CLIENTS = Math.max(1, PG_POOL_MAX - 1);
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

/**
 * 31-bit signed-positive int hash of a string identity, for Postgres advisory
 * lock keys. `pg_advisory_lock` takes a bigint; hashing a string identity down
 * to one keys the lock by identity, not by row presence. Collisions just make
 * two unrelated keys serialize (correctness preserved); 31 bits ≈ 2B buckets,
 * so collision risk is negligible.
 */
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

/**
 * Run `fn` while holding a Postgres SESSION-level advisory lock keyed by
 * `scopeKey`, serializing it across every process/replica sharing the database.
 * The lock is held on a dedicated pooled connection for the whole of `fn` and
 * released in `finally` (session-level, not xact-scoped, because callers may run
 * long — e.g. provisioning a server).
 *
 * On the PGlite driver (single embedded process — desktop/dev) there is nothing
 * to coordinate across processes, so this is a passthrough; callers still layer
 * an in-process mutex on top for same-process serialization.
 */
export async function withAdvisoryLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
  if (getDriver() === "pglite") {
    return fn();
  }

  const releasePermit = await acquirePostgresLockPermit();
  const key = hashStringToInt(scopeKey);
  let client;
  try {
    client = await getPgPool().connect();
  } catch (err) {
    releasePermit();
    throw err;
  }
  let clientError: Error | undefined;
  try {
    try {
      await client.query("SELECT pg_advisory_lock($1)", [key]);
    } catch (err) {
      clientError = errorForPool(err);
      throw err;
    }
    try {
      return await fn();
    } finally {
      try {
        const result = await client.query<{ pg_advisory_unlock: boolean }>(
          "SELECT pg_advisory_unlock($1)",
          [key],
        );
        if (result.rows[0]?.pg_advisory_unlock !== true) {
          throw new Error(`Postgres advisory lock ${scopeKey} was not owned during release`);
        }
      } catch (err) {
        clientError = errorForPool(err);
        throw err;
      }
    }
  } finally {
    client.release(clientError);
    releasePermit();
  }
}

/**
 * Try to acquire a session-level advisory lock without waiting. The returned
 * handle owns its pooled connection until release, so callers can hold the lock
 * across lifecycles that outlive a single awaited function (for example SSE).
 */
export async function tryAcquireAdvisoryLock(scopeKey: string): Promise<AdvisoryLockHandle | null> {
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
