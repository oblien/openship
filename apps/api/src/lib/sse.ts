/**
 * Drop-in replacement for Hono's `streamSSE` with automatic keep-alive.
 * Sends a ping every HEARTBEAT_INTERVAL_MS to prevent proxy/CDN drops.
 */

import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { streamSSE as _streamSSE } from "hono/streaming";
import { SYSTEM } from "@repo/core";

export function streamSSE(
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>,
) {
  return _streamSSE(c, async (sseStream) => {
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
