/**
 * Drop-in replacement for Hono's `streamSSE` with automatic keep-alive.
 * Sends a ping every HEARTBEAT_INTERVAL_MS to prevent proxy/CDN drops.
 *
 * Every write — the keep-alive ping AND the handler's own events — is funnelled
 * through ONE promise chain (see `serializeWrites`). The keep-alive is a timer,
 * so it fires whenever it likes: without serialization it can start a write
 * while the handler's `await writeSSE(...)` is mid-flight, and the last frame
 * before the stream closes is the one that loses that race. That frame is
 * usually the TERMINAL event, and a client that never receives it can only
 * report "the connection closed before the operation reported a result" for an
 * operation the server actually finished (the verify modal's exact symptom).
 * Serializing here fixes it for every SSE consumer at once.
 *
 * Ordering alone is NOT enough, though. Serialization guarantees a frame leaves
 * AFTER the ones before it — it cannot guarantee it leaves at all, because Hono
 * closes the stream as soon as the handler resolves. A handler that awaits its
 * terminal write is safe; the session-broadcast handlers are not, since they
 * push through a synchronous `(event, data) => boolean` writer that does
 * `void writeSSE(...)` and has nothing to await. Their `complete`/`end` frames
 * sat in the queue while the handler returned, so the stream closed on top of
 * them — the "Set up edge routing" modal reporting a dropped connection for a
 * run that had already logged "Done — routes are live". Hence `drain()`: the
 * handler's queued frames are flushed before the stream is allowed to close.
 */

import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { streamSSE as _streamSSE } from "hono/streaming";
import { SYSTEM } from "@repo/core";

/**
 * Replace `stream.writeSSE` with a version that queues behind every earlier
 * call, so two concurrent callers can never interleave their frames or flush out
 * of order. The original method is bound to the real instance (never re-invoked
 * through the shadowing property) so the stream's own internals are untouched;
 * the returned promise still resolves per-call, so `await writeSSE(...)` keeps
 * meaning "my frame is queued in order".
 *
 * Returns `drain()` — resolves once every write queued so far has settled. A
 * fire-and-forget writer (`void writeSSE(...)`) has no other way to know its
 * frame actually went out, and the frames it drops that way are the terminal
 * ones. Never rejects: a failed write is a gone client, which drains fine.
 */
export function serializeWrites(stream: SSEStreamingApi): () => Promise<void> {
  const write = stream.writeSSE.bind(stream);
  let tail: Promise<unknown> = Promise.resolve();
  stream.writeSSE = (message) => {
    const result = tail.then(() => write(message));
    // The tail must never reject, or one failed write would poison every
    // later one (a disconnected client would silently drop the rest).
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  return async () => {
    // Re-await while the tail keeps moving: a frame can be enqueued BY an
    // earlier frame's completion (a broadcast fanning out to the next
    // subscriber), and awaiting the tail once would return before those.
    // Bounded so a writer looping on its own completion can't spin here.
    for (let i = 0; i < DRAIN_PASSES; i++) {
      const settled = tail;
      await settled;
      if (settled === tail) return;
    }
  };
}

/** Max drain re-checks. More than a couple means writes are still being
 *  produced, which is the handler's problem, not the stream's. */
const DRAIN_PASSES = 8;

/** `drain()` bounded by a deadline — a client that has gone away never accepts
 *  the queued frames, and waiting on it would hold the response open. */
async function drainWithDeadline(drain: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function streamSSE(
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>,
) {
  // Disable reverse-proxy response buffering. nginx/OpenResty buffer proxied
  // responses by default, which holds SSE events back until the buffer fills —
  // the stream lags or appears stuck once deployed behind OpenResty, even
  // though localhost (no proxy) streams fine. nginx turns off proxy_buffering
  // for any response carrying this header. Must be set before streamSSE()
  // commits the headers; it never sets X-Accel-Buffering itself, so this
  // survives. The dashboard's /api/proxy relays it (not a hop-by-hop header),
  // so it reaches the edge through both the direct and proxied request paths.
  c.header("X-Accel-Buffering", "no");

  return _streamSSE(c, async (sseStream) => {
    const drain = serializeWrites(sseStream);

    const heartbeat = setInterval(() => {
      void sseStream
        .writeSSE({ event: "ping", data: "{}" })
        .catch(() => {});
    }, SYSTEM.SSE.HEARTBEAT_INTERVAL_MS);

    sseStream.onAbort(() => clearInterval(heartbeat));

    try {
      await cb(sseStream);
    } finally {
      // Stop the ping BEFORE draining, so the timer can't keep extending the
      // queue we're waiting on, then let the handler's queued frames — the
      // terminal `complete`/`end` among them — reach the client. Returning
      // from here is what closes the stream, so this is the last chance.
      clearInterval(heartbeat);
      await drainWithDeadline(drain, SYSTEM.SSE.TERMINAL_DRAIN_TIMEOUT_MS);
    }
  });
}
