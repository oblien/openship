import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The HOST channel is pooled, and these tests pin the property that #291 was
 * missing rather than the one that merely looks right.
 *
 * `createHostExecutor()` is a FACTORY: when the API is containerized it builds a
 * NEW SshExecutor to the host on every call, so an unpooled caller leaked one sshd
 * session per call — 8,000+ in a few hours, then OOM. Pooling alone isn't the fix
 * to assert; the fix is that the connection is (a) created once, (b) actually
 * CLOSED when idle, and (c) never closed while a borrower still holds it.
 */

const h = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  /** Rows by id — `isLocalHostRow` reads `isLocal`. */
  rows: {} as Record<string, { id: string; isLocal: boolean; sshHost?: string } | undefined>,
  makeExecutor: () => ({}) as Record<string, unknown>,
}));

vi.mock("@repo/db", () => ({
  repos: { server: { get: vi.fn(async (id: string) => h.rows[id]) } },
}));

vi.mock("@repo/adapters", () => ({
  createHostExecutor: vi.fn(() => {
    h.created += 1;
    return {
      // Only `dispose` matters here; the manager feature-detects the rest.
      dispose: vi.fn(async () => {
        h.disposed += 1;
      }),
    };
  }),
}));

// isLocalHostRow decides "is this row THIS box". Keyed off the fixture flag so the
// test doesn't depend on env/loopback resolution.
vi.mock("./box-org", () => ({
  isLocalHostRow: vi.fn(async (row: { isLocal?: boolean }) => Boolean(row?.isLocal)),
}));

import { sshManager } from "./ssh-manager";

/** Reach into the pool — there's no public accessor, and the whole point is to
 *  assert the cache state that the leak was a symptom of. */
const pool = () => (sshManager as unknown as { servers: Map<string, unknown> }).servers;

beforeEach(() => {
  h.created = 0;
  h.disposed = 0;
  h.rows = {
    "local-1": { id: "local-1", isLocal: true, sshHost: "127.0.0.1" },
    "local-2": { id: "local-2", isLocal: true, sshHost: "10.0.0.5" },
  };
  for (const key of [...pool().keys()]) {
    (sshManager as unknown as { dropServer: (k: string, f?: boolean) => void }).dropServer(
      key,
      true,
    );
  }
  h.created = 0;
  h.disposed = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("host channel pooling", () => {
  it("builds ONE executor across repeated withHostExecutor calls", async () => {
    // The regression shape: this endpoint-style call used to mint a connection each
    // time. Ten calls, one connection.
    const seen = new Set<unknown>();
    for (let i = 0; i < 10; i++) {
      await sshManager.withHostExecutor(async (exec) => {
        seen.add(exec);
        return true;
      });
    }
    expect(h.created).toBe(1);
    expect(seen.size).toBe(1);
    expect(h.disposed).toBe(0);
  });

  it("does not dispose on scope exit — the pool owns the lifetime", async () => {
    // The old idiom required every caller to dispose; the new one must NOT, or two
    // concurrent callers would close each other's connection.
    await sshManager.withHostExecutor(async () => true);
    expect(h.disposed).toBe(0);
  });

  it("dedups concurrent first-acquires instead of orphaning N-1 connections", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sshManager.withHostExecutor(async (exec) => exec)),
    );
    expect(h.created).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("propagates the acquire failure instead of reporting a phantom success", async () => {
    // createHostExecutor throws by design when the API is containerized with no
    // host channel. Swallowing that is how a caller concludes "host reachable".
    const { createHostExecutor } = await import("@repo/adapters");
    vi.mocked(createHostExecutor).mockImplementationOnce(() => {
      throw new Error("no host channel is configured");
    });
    await expect(sshManager.withHostExecutor(async () => "nope")).rejects.toThrow(
      /no host channel/,
    );
  });
});

describe("host channel is reclaimed, not merely reused", () => {
  it("disposes the connection once idle — the part that actually stops the leak", async () => {
    vi.useFakeTimers();
    await sshManager.withHostExecutor(async () => true);
    expect(h.created).toBe(1);
    expect(h.disposed).toBe(0);

    // Past the idle window: the pool must CLOSE it, or "pooled" just means the leak
    // grows more slowly.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(h.disposed).toBe(1);

    // And a later caller transparently gets a fresh one.
    vi.useRealTimers();
    await sshManager.withHostExecutor(async () => true);
    expect(h.created).toBe(2);
  });
});

describe("local server rows share the one host channel", () => {
  it("two different local rows do not open two host connections", async () => {
    const a = await sshManager.acquire("local-1");
    const b = await sshManager.acquire("local-2");
    expect(h.created).toBe(1);
    expect(a).toBe(b);
  });

  it("a local row is cached so probeReachable can short-circuit", async () => {
    await sshManager.acquire("local-1");
    expect(pool().has("local-1")).toBe(true);
  });

  it("dropping a BORROWED row never closes the shared connection", async () => {
    // The trap in sharing one executor under several keys: idle-dropping one local
    // row must not end the channel the other row and withHostExecutor still use.
    await sshManager.acquire("local-1");
    await sshManager.acquire("local-2");
    (sshManager as unknown as { dropServer: (k: string, f?: boolean) => void }).dropServer(
      "local-1",
      true,
    );

    expect(h.disposed).toBe(0);
    expect(pool().has("local-1")).toBe(false);
    // Still usable through the other borrower and the channel itself.
    await sshManager.withHostExecutor(async () => true);
    expect(h.created).toBe(1);
  });
});

describe("host channel survives while a borrower is live (the owner/borrower lifecycle)", () => {
  it("never serves a disposed executor when the owner idles under a HOT borrower", async () => {
    // Regression: the top-of-acquire fast path used to return the row's borrow
    // marker and refresh only ITS idle timer — so the owner idled out and disposed
    // the shared executor while the row was still being acquired, and the next
    // acquire handed back a DISPOSED executor. Re-acquiring a local row must keep
    // the owner alive.
    vi.useFakeTimers();
    const a = await sshManager.acquire("local-1");
    expect(h.created).toBe(1);

    // Keep the borrower hot with a cache-hit BEFORE its 5-min window, crossing the
    // owner's ORIGINAL 5-min deadline in the process.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await sshManager.acquire("local-1");
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    const b = await sshManager.acquire("local-1");
    expect(h.disposed).toBe(0); // owner never idled out from under the live row
    expect(h.created).toBe(1); // …so it was never rebuilt
    expect(b).toBe(a); // …and the same live executor is still handed out
    vi.useRealTimers();
  });

  it("keeps the shared channel alive across a retain placed BEFORE the first acquire", async () => {
    // The real call order for a stream/deploy is retain(rowId) THEN acquire(rowId);
    // retain can't yet know the row is local, so protection is enforced at drop
    // time. A hold longer than the idle window must not lose the channel.
    vi.useFakeTimers();
    sshManager.retain("local-1");
    await sshManager.acquire("local-1");
    expect(h.created).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000); // well past the 5-min idle window
    expect(h.disposed).toBe(0); // guard: a borrowing row is retained

    const live = await sshManager.withHostExecutor(async () => "ok");
    expect(live).toBe("ok"); // still the same live channel
    expect(h.created).toBe(1);

    // Releasing re-arms the owner's idle timer, so it IS reclaimed once idle.
    sshManager.release("local-1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.disposed).toBe(1);
    vi.useRealTimers();
  });
});
