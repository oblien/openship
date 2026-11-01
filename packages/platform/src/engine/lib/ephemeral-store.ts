/**
 * @module ephemeral-store
 *
 * Adapter for short-lived, single-use server-side state with TTL —
 * the building block under OAuth bridge tokens (oauthBridges), GitHub
 * install state tokens (installStates), and any future single-shot
 * server-state needs.
 *
 * Why an adapter:
 *   - The default impl is process-local (in-memory Map). Fine when the
 *     SaaS is a single process. The moment you scale to N replicas
 *     behind a load balancer, an OAuth bridge issued on replica A and
 *     consumed on replica B disappears — silent breakage.
 *   - The adapter lets us swap to Redis (or any other shared store)
 *     without touching the consumers. Just construct a different
 *     `EphemeralStore<T>` impl and inject it where the default is used.
 *
 * Contract:
 *   - `issue(value, opts)` mints a 16-byte random token, stores
 *     (token → value) with a TTL, returns the token.
 *   - `consume(token)` reads + deletes the entry in one shot. Returns
 *     the value if present and unexpired, else null. Single-use.
 *   - Implementations MUST be safe under concurrent consume of the
 *     same token — only one caller gets the value, the others get
 *     null. The in-memory impl uses `Map.delete()` as a synchronous
 *     check-and-clear; a Redis impl would use ATOMIC `GETDEL` or
 *     `EVAL`-scripted check.
 *
 * The token is generated INSIDE issue() so callers can't introduce
 * predictable keys. Tokens are URL-safe base64 (no `+`, `/`, `=`),
 * so they pass through query parameters without encoding overhead.
 */

import crypto from "node:crypto";

export interface EphemeralStoreIssueOpts {
  /** Time-to-live in milliseconds. Required — there's no "permanent" mode. */
  ttlMs: number;
}

export interface EphemeralStore<T> {
  /** Mint a token bound to `value`. Returns the token. */
  issue(value: T, opts: EphemeralStoreIssueOpts): Promise<string>;
  /** Atomically read + delete. Returns the value or null. */
  consume(token: string): Promise<T | null>;
  /** Test-only: clear all entries. */
  _reset?(): void;
}

/**
 * Process-local in-memory implementation. Single-process safe. Loses
 * all state on restart (acceptable — every consumer has a "if missing,
 * tell the user to try again" path).
 *
 * NOT safe for multi-replica deployments — see module docstring for
 * the migration path to a Redis-backed impl.
 */
class InMemoryEphemeralStore<T> implements EphemeralStore<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  private sweepExpired(now: number): void {
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }

  async issue(value: T, opts: EphemeralStoreIssueOpts): Promise<string> {
    const now = Date.now();
    this.sweepExpired(now);
    const token = crypto.randomBytes(16).toString("base64url");
    this.store.set(token, { value, expiresAt: now + opts.ttlMs });
    return token;
  }

  async consume(token: string): Promise<T | null> {
    const row = this.store.get(token);
    if (!row) return null;
    // Atomic check-and-clear within the single-threaded JS event loop:
    // delete BEFORE checking expiry so two concurrent consumers can't
    // both see a non-null row. The second one's get returns undefined.
    this.store.delete(token);
    if (row.expiresAt <= Date.now()) return null;
    return row.value;
  }

  _reset(): void {
    this.store.clear();
  }
}

export function createEphemeralStore<T>(): EphemeralStore<T> {
  return new InMemoryEphemeralStore<T>();
}
