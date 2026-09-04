import { describe, expect, it } from "vitest";

import { readSseTerminalEvent } from "./sse-terminal";

function splitStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("readSseTerminalEvent", () => {
  it("ignores comments and heartbeats and reassembles a split terminal frame", async () => {
    const result = await readSseTerminalEvent(
      splitStream([
        ": ok\n\nevent: ping\ndata: {}\n\nevent: comp",
        'lete\ndata: {"ok":',
        "true}\n\n",
      ]),
    );
    expect(result).toEqual({ event: "complete", data: '{"ok":true}' });
  });

  it("supports CRLF and multiline data", async () => {
    const result = await readSseTerminalEvent(
      splitStream(["event: error\r\ndata: line one\r\ndata: line two\r\n\r\n"]),
    );
    expect(result).toEqual({ event: "error", data: "line one\nline two" });
  });

  it("fails closed when the stream ends without a terminal event", async () => {
    await expect(readSseTerminalEvent(splitStream(["event: ping\ndata: {}\n\n"]))).rejects.toThrow(
      "without a terminal result",
    );
  });

  it("rejects an unbounded frame instead of buffering it indefinitely", async () => {
    await expect(
      readSseTerminalEvent(splitStream([`data: ${"x".repeat(1_000_001)}`])),
    ).rejects.toThrow("oversized frame");
  });
});
