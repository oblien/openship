import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";

// A plain static import: rate-limit.ts is self-contained and never reaches
// src/env, so there is no secret-writing side effect to sequence around.
import { createRateLimiter } from "../src/lib/rate-limit";

type CreateRateLimiter = typeof createRateLimiter;
type RateLimiter = ReturnType<CreateRateLimiter>;

const activeLimiters = new Set<RateLimiter>();

function makeLimiter(...args: Parameters<CreateRateLimiter>): RateLimiter {
  const limiter = createRateLimiter(...args);
  activeLimiters.add(limiter);
  return limiter;
}

// The runner's clock controls the fixed-window arithmetic without real delays.
beforeEach(() => {
  setSystemTime(0);
});
afterEach(() => {
  for (const limiter of activeLimiters) limiter.destroy();
  activeLimiters.clear();
  setSystemTime();
});

describe("createRateLimiter", () => {
  it("accepts exactly max hits and rejects hit max plus one", () => {
    const limiter = makeLimiter({ windowMs: 1000, max: 2 });

    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 1, retryAfter: 0 });
    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    // An off-by-one lets credential stuffing through or locks out a valid user.
    expect(limiter.hit("user")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
  });

  it("rolls over at resetAt but not one millisecond before it", () => {
    setSystemTime(10_000);
    const limiter = makeLimiter({ windowMs: 100, max: 1 });

    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    setSystemTime(10_099);
    // Expiring early gives an attacker an extra attempt inside the same window.
    expect(limiter.hit("user")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
    setSystemTime(10_100);
    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
  });

  it("never reports a zero retry delay while a rejected window is still live", () => {
    setSystemTime(20_000);
    const limiter = makeLimiter({ windowMs: 1000, max: 1 });

    limiter.hit("user");
    setSystemTime(20_999);
    // A zero retry value near rollover can make clients retry in a tight loop.
    expect(limiter.hit("user")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
  });

  it("keeps remaining exact and never negative after rejection", () => {
    const limiter = makeLimiter({ windowMs: 1000, max: 3 });

    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 2, retryAfter: 0 });
    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 1, retryAfter: 0 });
    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    expect(limiter.hit("user")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
    expect(limiter.hit("user")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
  });

  it("keeps buckets independent for different keys", () => {
    const limiter = makeLimiter({ windowMs: 1000, max: 1 });

    // Sharing buckets across identities lets one attacker deny service to others.
    expect(limiter.hit("first")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    expect(limiter.hit("second")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    expect(limiter.hit("first").ok).toBe(false);
    expect(limiter.hit("second").ok).toBe(false);
  });

  it("resets only the requested key", () => {
    const limiter = makeLimiter({ windowMs: 1000, max: 1 });

    limiter.hit("first");
    limiter.hit("second");
    limiter.reset("first");
    // A global reset would let an attacker clear throttling for every account.
    expect(limiter.hit("first")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    expect(limiter.hit("second")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
  });

  it("destroy stops the GC timer and clears buckets", () => {
    const clear = spyOn(globalThis, "clearInterval");
    try {
      const limiter = makeLimiter({ windowMs: 10, max: 2 });
      limiter.hit("user");
      limiter.destroy();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(limiter.hit("user")).toEqual({ ok: true, remaining: 1, retryAfter: 0 });
    } finally {
      clear.mockRestore();
    }
  });

  it("GC removes expired buckets but keeps live buckets", () => {
    // Bun's clock does not advance the timer queue. Capture and invoke the REAL
    // sweep callback; the harmless replacement timer is still owned/destroyed by
    // the limiter, and no implementation of the collection logic is mocked.
    const schedule = globalThis.setInterval;
    let sweep: (() => void) | undefined;
    const interval = spyOn(globalThis, "setInterval").mockImplementation((callback: () => void) => {
      sweep = callback;
      return schedule(() => {}, 60_000);
    });
    try {
      setSystemTime(30_000);
      const limiter = makeLimiter({ windowMs: 10, max: 1 });
      limiter.hit("expired"); // resetAt 30_010
      setSystemTime(30_005);
      limiter.hit("live"); // resetAt 30_015
      setSystemTime(30_010);
      expect(sweep).toBeDefined();
      sweep!();

      // Rewind so hit() cannot expire the buckets itself. Only a real sweep
      // can make the expired bucket fresh while the live one still blocks.
      setSystemTime(30_005);
      expect(limiter.hit("expired")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
      expect(limiter.hit("live")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
    } finally {
      interval.mockRestore();
    }
  });
});
