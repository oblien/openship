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
