/**
 * Rate-limit module — public API.
 *
 *   await rateLimit({ policy: "auth-tight", subjectId: ip })
 *
 * Mirrors cache-store: one shared Redis connection across all callers
 * (or the in-memory fallback), backend chosen once at first call.
 *
 * SaaS uses Redis (`REDIS_URL` reachable). Self-hosted PGlite installs
 * fall back to in-memory — fine for single-instance setups where the
 * per-process counter IS the global counter. Force a backend with
 * `OPENSHIP_RATE_LIMIT_STORE=memory|redis`.
 */

import IORedis from "ioredis";
import { env, REDIS_REQUIRED } from "../../config/env";
import { isRedisReachable } from "../../lib/redis";
import { MemoryRateLimitStore } from "./memory-store";
import { RedisRateLimitStore } from "./redis-store";
import { getPolicy, type PolicyId } from "./policies";
import type { RateLimitResult, RateLimitStore } from "./types";

export type { PolicyId } from "./policies";
export type { RateLimitResult, RateLimitSubject } from "./types";

const NAMESPACE = "rl";

type Backend = "redis" | "memory";

let backendDecision: Backend | null = null;
let resolving: Promise<RateLimitStore> | null = null;
let store: RateLimitStore | null = null;
let sharedRedis: IORedis | null = null;

async function pickBackend(): Promise<Backend> {
  const override = (process.env.OPENSHIP_RATE_LIMIT_STORE ?? "")
    .toLowerCase()
    .trim();
  if (override === "memory") return "memory";
  if (override === "redis") return "redis";
  // Redis required (CLOUD_MODE / OPENSHIP_REQUIRE_REDIS): force redis, skip the
  // probe — per-replica in-memory counters would under-count the aggregate.
  if (REDIS_REQUIRED) return "redis";
  return (await isRedisReachable()) ? "redis" : "memory";
}

function getSharedRedis(): IORedis {
  if (sharedRedis) return sharedRedis;
  sharedRedis = new IORedis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  sharedRedis.on("error", (err) => {
    console.warn("[rate-limit:redis] connection error:", err.message);
  });
  return sharedRedis;
}

async function resolveStore(): Promise<RateLimitStore> {
  if (store) return store;
  if (resolving) return resolving;
  resolving = (async () => {
    const backend = await pickBackend();
    backendDecision = backend;
    store =
      backend === "redis"
        ? new RedisRateLimitStore(getSharedRedis(), NAMESPACE)
        : new MemoryRateLimitStore();
    resolving = null;
    return store;
  })();
  return resolving;
}

export interface RateLimitInput {
  /** Named policy from `policies.ts`. */
  policy: PolicyId;
  /**
   * Subject identifier — IP / userId / orgId — chosen by the caller
   * to match the policy's `subject`. Empty string is rejected (would
   * collide all subjects into a single bucket).
   */
  subjectId: string;
}

/**
 * Apply a rate-limit check + increment for the given policy and
 * subject. Returns the result; caller decides how to respond to a
 * `!allowed` (typically 429 with Retry-After).
 *
 * Fail-open on store errors: if Redis is unreachable mid-request, the
 * call returns allowed=true rather than locking out every user. Rate-
 * limiting is a defense-in-depth layer, not the primary auth gate —
 * the trade-off favors availability over over-rejection on incident.
 */
export async function rateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  if (!input.subjectId) {
    throw new Error(
      `rate-limit: empty subjectId for policy "${input.policy}" — caller must provide a real identifier`,
    );
  }
  const policy = getPolicy(input.policy);
  const key = `${policy.id}:${policy.subject}:${input.subjectId}`;
  try {
    const s = await resolveStore();
    return await s.checkAndIncrement(key, policy.windowMs, policy.limit);
  } catch (err) {
    console.warn(
      `[rate-limit] check failed for ${key}, failing open:`,
      (err as Error).message,
    );
    return { allowed: true, remaining: policy.limit, resetMs: policy.windowMs };
  }
}

/** Active backend choice — null until first rateLimit() call. */
export function describeRateLimitStore(): Backend | null {
  return backendDecision;
}

/** Graceful shutdown. Idempotent. */
export async function shutdownRateLimit(): Promise<void> {
  if (store) {
    try {
      await store.dispose();
    } catch {
      /* best-effort */
    }
    store = null;
  }
  if (sharedRedis) {
    try {
      sharedRedis.disconnect();
    } catch {
      /* best-effort */
    }
    sharedRedis = null;
  }
  backendDecision = null;
}
