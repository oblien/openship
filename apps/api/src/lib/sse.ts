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
 */
export function serializeWrites(stream: SSEStreamingApi): void {
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
    serializeWrites(sseStream);

    const heartbeat = setInterval(() => {
      void sseStream
        .writeSSE({ event: "ping", data: "{}" })
        .catch(() => {});
    }, SYSTEM.SSE.HEARTBEAT_INTERVAL_MS);

    sseStream.onAbort(() => clearInterval(heartbeat));

    try {
      await cb(sseStream);
    } finally {
      clearInterval(heartbeat);
    }
  });
}
