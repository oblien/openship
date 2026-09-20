import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dockerMigrationApi, ScanStreamStalledError, isScanStreamStalled } from "./server-migration";
import type { DiscoveredStack } from "./server-migration";

/**
 * GH-570: behind a proxy that buffers `text/event-stream`, the scan stream answers
 * 200 and then delivers nothing. A read on that body never resolves and never
 * rejects, so `scanStream` used to hang forever and the wizard's spinner with it —
 * there was no timeout of any kind, by design ("no fixed client timeout").
 *
 * The fix has to distinguish three states that all look like "no result yet":
 *   - transport dead        → ScanStreamStalledError, so the caller can re-POST
 *   - scan slow but alive   → keep waiting, no matter how long
 *   - scan genuinely failed → the real error, NOT a stall (re-POSTing would just
 *                             reproduce it while hiding the message)
 */

const STREAM_HEADERS = { "content-type": "text/event-stream" };

/**
 * Stub `fetch` with a stream we drive by hand. The abort wiring is the part that
 * matters: real fetch errors the body stream when its signal aborts, and without
 * modelling that a "silent stream" test would hang instead of failing.
 */
function mockStream(headers: Record<string, string> = STREAM_HEADERS) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  const enc = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        try {
          ctl.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          /* already settled */
        }
      });
      return new Response(body, { status: 200, headers });
    }),
  );
  return {
    push: (chunk: string) => ctl.enqueue(enc.encode(chunk)),
    frame: (payload: unknown) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`)),
    close: () => ctl.close(),
  };
}

const STACK = { adoptable: true, groups: [] } as unknown as DiscoveredStack;

/** Attach the handler immediately so a rejection is never unhandled. */
function start(opts: Parameters<typeof dockerMigrationApi.scanStream>[1] = {}) {
  return dockerMigrationApi.scanStream("srv_1", opts).then(
    (stack) => ({ stack, err: null as unknown }),
    (err: unknown) => ({ stack: null, err }),
  );
}

describe("dockerMigrationApi.scanStream — a buffered transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up on a 200 that never sends a byte, instead of waiting forever", async () => {
    mockStream();
    const settled = start();

    await vi.advanceTimersByTimeAsync(14_000);
    // Nothing yet: the wait has to be long enough to survive a slow proxy hop.
    expect((await Promise.race([settled, Promise.resolve("pending")])) as unknown).toBe("pending");

    await vi.advanceTimersByTimeAsync(2_000);
    const { err } = await settled;
    expect(err).toBeInstanceOf(ScanStreamStalledError);
    expect(isScanStreamStalled(err)).toBe(true);
  });

  it("gives up when the stream opens, primes, then goes quiet mid-scan", async () => {
    const s = mockStream();
    const settled = start();

    s.push(": ok\n\n");
    // The primer bought a fresh idle budget — the first-byte deadline is gone, and
    // the new one has to clear two missed 25s heartbeats.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await Promise.race([settled, Promise.resolve("pending")])) as unknown).toBe("pending");

    await vi.advanceTimersByTimeAsync(12_000);
    expect(isScanStreamStalled((await settled).err)).toBe(true);
  });

  it("treats a 200 that is not an event-stream as a dead transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { err } = await start();
    expect(err).toBeInstanceOf(ScanStreamStalledError);
    expect((err as Error).message).toContain("application/json");
  });

  it("treats a close with no result as a dead transport too", async () => {
    const s = mockStream();
    const settled = start();

    s.push(": ok\n\n");
    s.close();

    await vi.advanceTimersByTimeAsync(0);
    expect(isScanStreamStalled((await settled).err)).toBe(true);
  });
});

describe("dockerMigrationApi.scanStream — a live transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never gives up on a scan that is slow but still heartbeating", async () => {
    const s = mockStream();
    const settled = start();

    // Three minutes — far past any single deadline — with a keep-alive every 20s.
    for (let i = 0; i < 9; i++) {
      s.push(": ok\n\n");
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect((await Promise.race([settled, Promise.resolve("pending")])) as unknown).toBe("pending");

    s.frame({ type: "result", stack: STACK });
    await vi.advanceTimersByTimeAsync(0);
    expect((await settled).stack).toEqual(STACK);
  });

  it("reports progress and resolves the result", async () => {
    const s = mockStream();
    const seen: string[] = [];
    const settled = start({ onProgress: (m) => seen.push(m) });

    s.frame({ type: "progress", message: "Connecting to Docker…" });
    await vi.advanceTimersByTimeAsync(0);
    s.frame({ type: "result", stack: STACK });
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual(["Connecting to Docker…"]);
    expect((await settled).stack).toEqual(STACK);
  });

  it("surfaces a scan failure as itself, not as a stall", async () => {
    const s = mockStream();
    const settled = start();

    s.frame({ type: "error", error: "Scan failed: Permission denied (publickey)" });
    await vi.advanceTimersByTimeAsync(0);

    const { err } = await settled;
    // A stall would make the caller silently re-POST, which reproduces the failure
    // and swallows this sentence.
    expect(isScanStreamStalled(err)).toBe(false);
    expect((err as Error).message).toContain("Permission denied");
  });
});
