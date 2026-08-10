import { describe, it, expect } from "vitest";

import { streamChunkBytes } from "../../src/lib/project-analytics";

/**
 * The server-logs live tail relays the EDGE's SSE frames. `pipe_stream.lua` emits
 * `event: request\ndata: {…}\n\n`, and a frame is only dispatched by the browser
 * when it sees the terminating BLANK line.
 *
 * The exec transport carries those bytes through `streamExec`, which is a raw
 * passthrough on every real executor ("Do NOT split on \n or trim here") — so a
 * chunk is an arbitrary slice and can land mid-line. The old code wrote
 * `${log.message}\n` per chunk, which inserted a newline wherever the split
 * happened: inside a `data:` line as often as after one. A frame cut mid-JSON
 * arrives truncated, the client's `JSON.parse` throws, and the event is silently
 * dropped — a live tail that stays empty until you reload and the history fetch
 * fills it in.
 *
 * So: relaying must be byte-exact, and the reassembled stream must equal what the
 * edge sent, no matter where the chunks were cut.
 */

const entry = (message: string, raw?: string) => ({
  timestamp: "2026-07-30T00:00:00.000Z",
  message,
  level: "info" as const,
  ...(raw ? { rawData: raw } : {}),
});

const chunk = (bytes: string) =>
  entry(bytes, Buffer.from(bytes, "utf8").toString("base64"));

describe("streamChunkBytes", () => {
  it("prefers the untouched bytes over the decoded message", () => {
    // rawData is the exact chunk; message is a convenience view of it.
    const c = chunk("event: request\ndata: {}\n\n");
    expect(streamChunkBytes(c).toString()).toBe("event: request\ndata: {}\n\n");
  });

  it("adds NO trailing newline (the framing bug)", () => {
    const c = chunk("data: {}\n\n");
    expect(streamChunkBytes(c).toString().endsWith("\n\n")).toBe(true);
    expect(streamChunkBytes(c).toString()).not.toContain("\n\n\n");
  });

  it("falls back to the message for a synthesized entry with no rawData", () => {
    // Process-error entries are constructed, not captured, so they have no rawData.
    expect(streamChunkBytes(entry("Process error: boom")).toString()).toBe(
      "Process error: boom",
    );
  });

  it("reassembles a frame split mid-JSON byte-for-byte", () => {
    const frame = `event: request\ndata: {"ip":"203.0.113.7","status":200}\n\n`;
    // A split right inside the IP — the case that produced truncated JSON.
    const cut = frame.indexOf("203.0") + 3;
    const parts = [frame.slice(0, cut), frame.slice(cut)];

    const relayed = Buffer.concat(parts.map((p) => streamChunkBytes(chunk(p)))).toString();

    expect(relayed).toBe(frame);
    // And the payload the browser would parse survives intact.
    const data = relayed.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    expect(JSON.parse(data)).toEqual({ ip: "203.0.113.7", status: 200 });
  });

  it("keeps multiple frames in one chunk separately terminated", () => {
    const two = `event: request\ndata: {"n":1}\n\nevent: request\ndata: {"n":2}\n\n`;

    const relayed = streamChunkBytes(chunk(two)).toString();

    expect(relayed).toBe(two);
    expect(relayed.split("\n\n").filter(Boolean)).toHaveLength(2);
  });

  it("preserves the edge's heartbeat and comment lines verbatim", () => {
    // `: ping` keeps the connection warm; mangling it would break the keepalive.
    expect(streamChunkBytes(chunk(": ping\n\n")).toString()).toBe(": ping\n\n");
    expect(streamChunkBytes(chunk(": connected\n\n")).toString()).toBe(": connected\n\n");
  });

  it("does not corrupt non-ASCII bytes split across chunks", () => {
    // A UTF-8 path (multi-byte) cut mid-character: base64 round-trips the raw
    // bytes, so concatenating the buffers restores the character. Decoding each
    // chunk as a string first would replace the halves with U+FFFD.
    const frame = `data: {"path":"/café"}\n\n`;
    const bytes = Buffer.from(frame, "utf8");
    const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1; // inside the é
    const parts = [bytes.subarray(0, cut), bytes.subarray(cut)];

    const relayed = Buffer.concat(
      parts.map((p) => streamChunkBytes(entry("ignored", p.toString("base64")))),
    );

    expect(relayed.toString()).toBe(frame);
  });
});
