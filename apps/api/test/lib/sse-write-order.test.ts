import { describe, expect, it } from "vitest";
import type { SSEStreamingApi } from "hono/streaming";

import { serializeWrites } from "../../src/lib/sse";

/**
 * `streamSSE` has TWO writers on one stream: the handler's own events and the
 * keep-alive ping, which is a timer and so fires whenever it likes. Unserialized,
 * a ping can start a write while the handler's `await writeSSE(...)` is in flight,
 * and the frame that loses the race is the last one before the stream closes —
 * usually the TERMINAL event. A client that never receives it can only report that
 * the connection closed without a result, for an operation the server finished.
 *
 * So: frames must leave in call order, whole, even when writers interleave and
 * even when an earlier write fails.
 */

/** A stream whose write takes a caller-controlled amount of time to settle. */
function makeStream(delays: number[], failAt = -1) {
  const written: string[] = [];
  let call = 0;
  const stream = {
    writeSSE: async (message: { data: string }) => {
      const index = call++;
      await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 0));
      if (index === failAt) throw new Error("client gone");
      written.push(message.data);
    },
  } as unknown as SSEStreamingApi;
  return { stream, written };
}

describe("serializeWrites", () => {
  it("emits frames in CALL order even when the first write is the slowest", async () => {
    // Without serialization these resolve by duration: "ping", "log", "complete".
    const { stream, written } = makeStream([30, 10, 0]);
    serializeWrites(stream);

    await Promise.all([
      stream.writeSSE({ data: "log" }),
      stream.writeSSE({ data: "ping" }),
      stream.writeSSE({ data: "complete" }),
    ]);

    expect(written).toEqual(["log", "ping", "complete"]);
  });

  it("keeps a terminal frame queued BEHIND an in-flight ping rather than racing it", async () => {
    const { stream, written } = makeStream([25, 0]);
    serializeWrites(stream);

    void stream.writeSSE({ data: "ping" });
    await stream.writeSSE({ data: "complete" });

    // Awaiting the terminal write means every earlier frame has already gone out,
    // so closing the stream right after can't drop anything.
    expect(written).toEqual(["ping", "complete"]);
  });

  it("does not let one failed write poison the rest", async () => {
    // A disconnected client fails mid-stream; a rejected tail would silently drop
    // every frame after it.
    const { stream, written } = makeStream([0, 0, 0], 1);
    serializeWrites(stream);

    const results = await Promise.allSettled([
      stream.writeSSE({ data: "first" }),
      stream.writeSSE({ data: "boom" }),
      stream.writeSSE({ data: "third" }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(written).toEqual(["first", "third"]);
  });

  it("still resolves per-call, so `await writeSSE(...)` keeps its meaning", async () => {
    const { stream, written } = makeStream([5]);
    serializeWrites(stream);

    await stream.writeSSE({ data: "one" });
    expect(written).toEqual(["one"]);
  });
});

/**
 * Ordering is not delivery. `streamSSE` closes the stream the moment the handler
 * resolves, so a frame that is merely QUEUED at that point never goes out — and
 * the writers that can't await are precisely the ones that emit terminal frames:
 * the session-broadcast handlers push through a synchronous
 * `(event, data) => boolean` writer doing `void writeSSE(...)`. That is how the
 * edge-routing modal reported a dropped connection for a run whose last three
 * frames ("Done — routes are live", `complete`, `end`) were all still in the
 * queue. `drain()` is what the handler awaits so they aren't.
 */
describe("serializeWrites drain", () => {
  it("flushes frames a FIRE-AND-FORGET writer never awaited", async () => {
    const { stream, written } = makeStream([20, 20, 20]);
    const drain = serializeWrites(stream);

    // Exactly what a broadcast writer does — no await anywhere.
    void stream.writeSSE({ data: "log:done" });
    void stream.writeSSE({ data: "complete" });
    void stream.writeSSE({ data: "end" });

    // Without the drain the handler would return here and close on top of all three.
    expect(written).toEqual([]);
    await drain();
    expect(written).toEqual(["log:done", "complete", "end"]);
  });

  it("resolves even when the client is gone and every write fails", async () => {
    // A drain that rejected or hung would turn a disconnected client into a stuck
    // response — worse than the frame loss it exists to prevent.
    const { stream } = makeStream([0, 0], 0);
    const drain = serializeWrites(stream);

    void stream.writeSSE({ data: "complete" });
    void stream.writeSSE({ data: "end" });

    await expect(drain()).resolves.toBeUndefined();
  });

  it("also flushes a frame enqueued BY an earlier frame's completion", async () => {
    // A broadcast can fan out to the next subscriber as the previous write
    // settles, so the tail moves during the drain. Awaiting it once would return
    // before the frames that appeared meanwhile.
    const { stream, written } = makeStream([5, 5]);
    const drain = serializeWrites(stream);

    void stream.writeSSE({ data: "first" }).then(() => {
      void stream.writeSSE({ data: "second" });
    });

    await drain();
    expect(written).toEqual(["first", "second"]);
  });

  it("is a no-op when nothing was written", async () => {
    const { stream, written } = makeStream([]);
    const drain = serializeWrites(stream);
    await expect(drain()).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });
});
