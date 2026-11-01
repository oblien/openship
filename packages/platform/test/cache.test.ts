import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/state/cache";

describe("TtlCache", () => {
  it("stores and retrieves values within TTL", () => {
    const cache = new TtlCache<string>({ maxSize: 10, sweepIntervalMs: 0 });
    cache.set("a", "val-a", 100);
    expect(cache.get("a")).toBe("val-a");
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("returns null and lazily deletes expired entries", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>({ maxSize: 10, sweepIntervalMs: 0 });
      cache.set("a", "val-a", 10);
      expect(cache.get("a")).toBe("val-a");

      vi.advanceTimersByTime(11_000);
      expect(cache.get("a")).toBeNull();
      expect(cache.has("a")).toBe(false);
      expect(cache.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("strictly bounds size to maxSize by evicting oldest unexpired entries", () => {
    const cache = new TtlCache<string>({ maxSize: 3, sweepIntervalMs: 0 });
    cache.set("k1", "v1", 300);
    cache.set("k2", "v2", 300);
    cache.set("k3", "v3", 300);
    expect(cache.size).toBe(3);

    cache.set("k4", "v4", 300);
    expect(cache.size).toBe(3);
    expect(cache.get("k1")).toBeNull();
    expect(cache.get("k2")).toBe("v2");
    expect(cache.get("k3")).toBe("v3");
    expect(cache.get("k4")).toBe("v4");
  });

  it("updating an existing key does not evict other entries", () => {
    const cache = new TtlCache<string>({ maxSize: 2, sweepIntervalMs: 0 });
    cache.set("k1", "v1", 300);
    cache.set("k2", "v2", 300);
    expect(cache.size).toBe(2);

    cache.set("k1", "v1-updated", 300);
    expect(cache.size).toBe(2);
    expect(cache.get("k1")).toBe("v1-updated");
    expect(cache.get("k2")).toBe("v2");
  });

  it("evicts an empty-string key when it is the oldest entry", () => {
    const cache = new TtlCache<string>({ maxSize: 1, sweepIntervalMs: 0 });
    cache.set("", "old", 300);
    cache.set("next", "new", 300);
    expect(cache.size).toBe(1);
    expect(cache.get("")).toBeNull();
    expect(cache.get("next")).toBe("new");
  });

  it("evicts completed work before live work and refuses excess admission when all entries are in use", () => {
    const cache = new TtlCache<{ running: boolean }>({
      maxSize: 2,
      sweepIntervalMs: 0,
      canEvict: (value) => !value.running,
    });
    cache.set("live", { running: true }, 300);
    cache.set("finished", { running: false }, 300);
    cache.set("next", { running: true }, 300);
    expect(cache.has("live")).toBe(true);
    expect(cache.has("finished")).toBe(false);
    expect(cache.has("next")).toBe(true);
    expect(() => cache.set("excess", { running: true }, 300)).toThrow("all entries are in use");
    expect(cache.size).toBe(2);
    expect(cache.has("live")).toBe(true);
    expect(cache.has("next")).toBe(true);
    expect(cache.has("excess")).toBe(false);
  });

  it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid capacity %s before starting a timer", (maxSize) => {
    expect(() => new TtlCache({ maxSize })).toThrow("positive integer");
  });

  it("sweep removes all expired entries", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>({ maxSize: 10, sweepIntervalMs: 0 });
      cache.set("short1", "v", 5);
      cache.set("short2", "v", 5);
      cache.set("long", "v", 60);

      vi.advanceTimersByTime(10_000);
      expect(cache.size).toBe(3);

      cache.sweep();
      expect(cache.size).toBe(1);
      expect(cache.get("long")).toBe("v");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates keys by prefix and substring", () => {
    const cache = new TtlCache<string>({ maxSize: 10, sweepIntervalMs: 0 });
    cache.set("user:1", "u1", 300);
    cache.set("user:2", "u2", 300);
    cache.set("post:1", "p1", 300);

    cache.invalidateByPrefix("user:");
    expect(cache.has("user:1")).toBe(false);
    expect(cache.has("user:2")).toBe(false);
    expect(cache.has("post:1")).toBe(true);

    cache.invalidateBySubstring(":1");
    expect(cache.has("post:1")).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("cancels sweep timer on dispose", () => {
    const cache = new TtlCache<string>({ maxSize: 10, sweepIntervalMs: 10_000 });
    expect(() => cache.dispose()).not.toThrow();
  });
});
