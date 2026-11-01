import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the rateLimit() facade in src/lib/rate-limit/index.ts.
 *
 * The facade has module-level singleton state (backend decision, store,
 * shared redis). We call `shutdownRateLimit()` in `afterEach` to reset it.
 *
 * We mock:
 *   - `../../config/env`  — avoid loading the full zod-validated env.
 *   - `ioredis`           — never touch a real socket; isRedisReachable()
 *                            simulates a failure so the memory backend is chosen.
 *   - `./memory-store`    — replaced via `vi.doMock` per-test where we need
 *                            to force the store to throw (fail-open test).
 */

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
  },
}));

// Default mock: pretend Redis is not reachable. The facade falls back to
// the in-memory store, which is what most of these tests exercise.
vi.mock("ioredis", () => {
  class FakeIORedis {
    constructor(_url?: string, _opts?: unknown) {}
    async connect() {
      throw new Error("not reachable");
    }
    async ping() {
      return "PONG";
    }
    disconnect() {}
    on() {
      return this;
    }
  }
  return { default: FakeIORedis };
});

import {
  rateLimit,
  shutdownRateLimit,
  describeRateLimitStore,
} from "../../../src/lib/rate-limit";
import {
  POLICIES,
  getPolicy,
  type PolicyId,
} from "../../../src/lib/rate-limit/policies";

describe("rateLimit() facade", () => {
  beforeEach(() => {
    // Pin the env override so each test is deterministic.
    process.env.OPENSHIP_RATE_LIMIT_STORE = "memory";
  });

  afterEach(async () => {
    await shutdownRateLimit();
    delete process.env.OPENSHIP_RATE_LIMIT_STORE;
    vi.resetModules();
  });

  // ── 10 ──────────────────────────────────────────────────────────────────
  it("empty subjectId throws", async () => {
    await expect(
      rateLimit({ policy: "default-anon", subjectId: "" }),
    ).rejects.toThrow(/empty subjectId/);
  });

  // ── 11 ──────────────────────────────────────────────────────────────────
  it("unknown policy id throws", async () => {
    await expect(
      // Cast through unknown — we deliberately violate the type to test
      // runtime defence.
      rateLimit({
        policy: "this-policy-does-not-exist" as unknown as PolicyId,
        subjectId: "1.2.3.4",
      }),
    ).rejects.toThrow(/unknown policy/);
  });

  it("memory backend is selected when redis unreachable + override=memory", async () => {
    const res = await rateLimit({
      policy: "default-anon",
      subjectId: "1.2.3.4",
    });
    expect(res.allowed).toBe(true);
    expect(describeRateLimitStore()).toBe("memory");
  });
});

// ─── Fail-open behaviour ────────────────────────────────────────────────────
//
// For this slice we need the store to throw. We re-import the module fresh
// after mocking `memory-store` to inject a throwing implementation.
describe("rateLimit() fail-open on store error", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OPENSHIP_RATE_LIMIT_STORE = "memory";
  });

  afterEach(async () => {
    delete process.env.OPENSHIP_RATE_LIMIT_STORE;
    vi.resetModules();
    vi.doUnmock("../../../src/lib/rate-limit/memory-store");
  });

  // ── 12 ──────────────────────────────────────────────────────────────────
  it("returns allowed=true with policy.limit remaining when the store throws", async () => {
    vi.doMock("../../../src/lib/rate-limit/memory-store", () => ({
      MemoryRateLimitStore: class {
        readonly name = "memory" as const;
        async checkAndIncrement() {
          throw new Error("boom");
        }
        async dispose() {}
      },
    }));

    // Re-import the facade so it picks up the mock.
    const { rateLimit: rl, shutdownRateLimit: shutdown } = await import(
      "../../../src/lib/rate-limit"
    );

    const res = await rl({ policy: "default-anon", subjectId: "1.2.3.4" });
    expect(res.allowed).toBe(true);
    // Policy "default-anon" has limit=300.
    expect(res.remaining).toBe(300);
    expect(res.resetMs).toBe(60_000);

    await shutdown();
  });
});

// ─── POLICIES catalog sanity ────────────────────────────────────────────────
describe("POLICIES catalog", () => {
  // Every PolicyId in the union must be present in POLICIES. The TS compiler
  // already enforces this (Record<PolicyId, ...>), but a runtime guard catches
  // a missing entry in case the type drifts.
  const EXPECTED_IDS: PolicyId[] = [
    "default-anon",
    "default-authed",
    "auth-tight",
    "auth-loose",
    "read-authed",
    "write-authed",
    "webhook-ingress",
    "billing-portal",
  ];

  // ── 13 ──────────────────────────────────────────────────────────────────
  it.each(EXPECTED_IDS)("policy %s is registered", (id) => {
    expect(POLICIES[id]).toBeDefined();
    expect(POLICIES[id].id).toBe(id);
  });

  // ── 14 ──────────────────────────────────────────────────────────────────
  it.each(EXPECTED_IDS)("policy %s has limit>0 and windowMs>0", (id) => {
    const p = POLICIES[id];
    expect(p.limit).toBeGreaterThan(0);
    expect(Number.isInteger(p.limit)).toBe(true);
    expect(p.windowMs).toBeGreaterThan(0);
  });

  // ── 15 ──────────────────────────────────────────────────────────────────
  it("getPolicy('default-anon') returns the expected shape", () => {
    const p = getPolicy("default-anon");
    expect(p).toMatchObject({
      id: "default-anon",
      limit: 300,
      windowMs: 60_000,
      subject: "ip",
    });
    expect(typeof p.description).toBe("string");
  });

  it("getPolicy throws on unknown id", () => {
    expect(() =>
      getPolicy("nope" as unknown as PolicyId),
    ).toThrow(/unknown policy/);
  });
});
