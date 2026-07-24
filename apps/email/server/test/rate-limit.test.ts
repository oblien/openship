import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Fake timers drive both `Date.now()` and the GC `setInterval`, so the window
// arithmetic and the sweep can be advanced deterministically instead of slept
// through. Every case starts from a known epoch.
beforeEach(() => {
  vi.useFakeTimers();
});

// Always restore the clock and stop timers, even when an assertion fails. A
// leaked fake clock or GC interval can change the result of another test.
afterEach(() => {
  for (const limiter of activeLimiters) limiter.destroy();
  activeLimiters.clear();
  vi.useRealTimers();
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
    vi.setSystemTime(10_000);
    const limiter = makeLimiter({ windowMs: 100, max: 1 });

    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    vi.setSystemTime(10_099);
    // Expiring early gives an attacker an extra attempt inside the same window.
    expect(limiter.hit("user")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
    vi.setSystemTime(10_100);
    expect(limiter.hit("user")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
  });

  it("never reports a zero retry delay while a rejected window is still live", () => {
    vi.setSystemTime(20_000);
    const limiter = makeLimiter({ windowMs: 1000, max: 1 });

    limiter.hit("user");
    vi.setSystemTime(20_999);
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
    const originalClearInterval = globalThis.clearInterval;
    let cleared = false;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      cleared = true;
      originalClearInterval(timer);
    }) as typeof clearInterval;

    const limiter = makeLimiter({ windowMs: 10, max: 2 });
    limiter.hit("user");
    limiter.destroy();

    try {
      expect(cleared).toBe(true);
      expect(limiter.hit("user")).toEqual({ ok: true, remaining: 1, retryAfter: 0 });
    } finally {
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("GC removes expired buckets but keeps live buckets", () => {
    vi.setSystemTime(30_000);
    const limiter = makeLimiter({ windowMs: 10, max: 1 });

    limiter.hit("expired"); // resetAt 30_010

    // `advanceTimersByTime` rather than `setSystemTime` for the steps: only
    // the former moves the timer queue, and the GC interval has to actually
    // fire. setSystemTime would move Date.now() while leaving the sweep
    // pending, so nothing would be collected.
    vi.advanceTimersByTime(5);
    limiter.hit("live"); // resetAt 30_015

    // Lands exactly on the interval (windowMs = 10), firing the sweep with
    // only the first bucket at its deadline.
    vi.advanceTimersByTime(5);

    // GC is a memory concern, not a correctness one: hit() checks expiry on
    // its own. Rewinding below the live bucket's deadline is what makes the
    // two cases distinguishable — a swept bucket reads as fresh, while a
    // retained one still blocks. Without the rewind, both would simply look
    // expired and the assertion would prove nothing about the sweep.
    vi.setSystemTime(30_005);

    expect(limiter.hit("expired")).toEqual({ ok: true, remaining: 0, retryAfter: 0 });
    expect(limiter.hit("live")).toEqual({ ok: false, remaining: 0, retryAfter: 1 });
  });
});
