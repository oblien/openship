import { describe, expect, it } from "vitest";

import { parseSSE, type SSEEvent } from "../../src/lib/sse";

/** Build a byte stream from string chunks (chunk boundaries need not align to events). */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const ev of parseSSE(stream)) events.push(ev);
  return events;
}

describe("parseSSE", () => {
  it("parses a basic event with default name 'message'", async () => {
    const events = await collect(streamOf("data: hello\n\n"));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("honors event/id/retry fields and joins multiple data lines with \\n", async () => {
    const events = await collect(
      streamOf("event: log\nid: 7\nretry: 1000\ndata: line1\ndata: line2\n\n"),
    );
    expect(events).toEqual([{ event: "log", data: "line1\nline2", id: "7", retry: 1000 }]);
  });

  it("reassembles events split across chunk boundaries", async () => {
    const events = await collect(streamOf("data: par", "tial\n", "\n"));
    expect(events).toEqual([{ event: "message", data: "partial" }]);
  });

  it("tolerates CRLF line endings", async () => {
    const events = await collect(streamOf("event: x\r\ndata: y\r\n\r\n"));
    expect(events).toEqual([{ event: "x", data: "y" }]);
  });

  it("skips comment/keep-alive lines and empty flushes", async () => {
    const events = await collect(streamOf(": keep-alive\n\ndata: real\n\n"));
    expect(events).toEqual([{ event: "message", data: "real" }]);
  });

  it("flushes a trailing newline-terminated event that has no blank line", async () => {
    const events = await collect(streamOf("data: tail\n"));
    expect(events).toEqual([{ event: "message", data: "tail" }]);
  });

  it("drops a dangling partial line that never receives its newline", async () => {
    const events = await collect(streamOf("data: incomplete"));
    expect(events).toEqual([]);
  });
});
