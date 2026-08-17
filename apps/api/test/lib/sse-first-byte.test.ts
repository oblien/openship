import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { SSE_PRIMER, streamSSE } from "../../src/lib/sse";

/**
 * GH-570: a stream that is headed but empty is indistinguishable — to a client and
 * to every intermediary — from a dead one. Two things kept it that way: the
 * keep-alive's first ping is a full 25s interval away, and nothing announced the
 * stream before the handler started working. Both facts below are load-bearing for
 * SSE surviving a proxy chain, and neither had a test: deleting the header or the
 * primer shipped green.
 */
describe("streamSSE", () => {
  it("tells reverse proxies not to buffer the response", async () => {
    const app = new Hono();
    app.get("/", (c) => streamSSE(c, async (s) => void (await s.writeSSE({ data: "{}" }))));

    const res = await app.request("/");

    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("puts a byte on the wire before the handler produces anything", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      streamSSE(c, async (s) => {
        await new Promise((r) => setTimeout(r, 50));
        await s.writeSSE({ event: "result", data: "{}" });
      }),
    );

    const res = await app.request("/");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);

    // A comment frame: inert to every SSE parser, but real bytes to every proxy.
    expect(first).toBe(SSE_PRIMER);
    expect(SSE_PRIMER.startsWith(":")).toBe(true);
    await reader.cancel();
  });
});
