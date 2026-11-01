/**
 * Rate-limit types — Store backend + Policy descriptor.
 *
 * The Store is a tiny primitive: given a key + window + limit, atomically
 * return whether this request is allowed and how many remain. Two
 * backends mirror cache-store's pattern: in-memory (process-local) and
 * Redis (shared across replicas).
 *
 * The algorithm is sliding-window-counter — a weighted blend of the
 * current and previous fixed windows that approximates a true sliding
 * window with O(1) state per key. Cloudflare's published approach.
 * Mathematically:
 *
 *   estimated_rate(now)
 *     = count_in_current_window
 *     + count_in_previous_window * (1 - elapsed_in_current_window / window)
 *
 * Smooths the classic fixed-window boundary burst (e.g. 100 reqs at
 * t=59s and 100 more at t=61s) at the cost of slight over-rejection
 * near the boundary — preferable to under-rejection from a security
 * standpoint.
 */

export interface RateLimitStore {
  readonly name: "redis" | "memory";

  /**
   * Atomically check + increment in a single round-trip.
   *
   * `key`     — application-level key (already includes policy id + subject id).
   * `windowMs` — width of the rate window in ms.
   * `limit`    — max requests allowed inside the window.
   *
   * Returns `{ allowed, remaining, resetMs }`. `resetMs` is the
   * relative time in ms until the current window closes (for the
   * `Retry-After` header).
   *
   * When `allowed` is false, the counter is NOT incremented — repeated
   * rejections during the window don't push the counter past the cap.
   */
  checkAndIncrement(
    key: string,
    windowMs: number,
    limit: number,
  ): Promise<RateLimitResult>;

  /** Stop background timers / close connections. Idempotent. */
  dispose(): Promise<void>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the current window closes (used for Retry-After). */
  resetMs: number;
}

/**
 * Subject of the limit — what identity to count requests against.
 *
 *   - "ip"     — client IP (anonymous routes, public webhooks).
 *   - "user"   — `ctx.userId` (authed routes; per-user across IPs).
 *   - "org"    — `ctx.organizationId` (authed routes; shared org bucket).
 *   - "global" — single bucket per policy (system-wide circuit breakers).
 *   - "webhook" — stable endpoint identity plus client IP, with a separate IP ceiling.
 *
 * For authed routes prefer "user" or "org" over "ip" — IP-keying breaks
 * for CGNAT users and lets one teammate burn the whole org's quota.
 */
export type RateLimitSubject = "ip" | "user" | "org" | "global" | "webhook";

export interface RateLimitPolicy {
  /** Stable id — appears in the Redis key, so changes invalidate state. */
  id: string;
  /** Per-window limit (whole requests, integer). */
  limit: number;
  /** Window width in milliseconds. */
  windowMs: number;
  /** What identity to count against. See RateLimitSubject. */
  subject: RateLimitSubject;
  /** Optional one-line note for operators reading the policy table. */
  description?: string;
}
