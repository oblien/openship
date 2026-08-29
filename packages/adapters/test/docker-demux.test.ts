/**
 * The demuxer's contract, pinned from the direction #633 broke it.
 *
 * The headline property is the one docker-modem does not have: a sink that says
 * "stop" is obeyed. It is asserted by measuring how far the SOURCE got, not by
 * inspecting the sink — "did we stop reading" is the actual question, and a test
 * that only counted delivered bytes would pass against the unbounded version too.
 */

import { describe, expect, it } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { demuxDockerStream } from "../src/runtime/docker-demux";

/** One multiplexed frame: `[type, 0, 0, 0, uint32be len]` + payload. */
function frame(type: 1 | 2, payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * A source that reports how many chunks were actually pulled out of it.
 *
 * `highWaterMark: 1` is load-bearing. With the 16 KB default, the stream's own
 * read buffer absorbs every test chunk the instant `_read` is called, so the count
 * would say "all of them" no matter what the consumer does — the instrument, not
 * the code, would be measuring nothing. At 1 byte the buffer holds one chunk, so
 * pulls stop when the demuxer stops reading, which is the property under test.
 */
function scriptedSource(chunks: Buffer[]): Readable & { delivered: () => number } {
  let i = 0;
  let delivered = 0;
  const src = new Readable({
    highWaterMark: 1,
    read() {
      if (i >= chunks.length) return void this.push(null);
      delivered += 1;
      this.push(chunks[i++]);
    },
  }) as Readable & { delivered: () => number };
  src.delivered = () => delivered;
  return src;
}

/** A sink that accepts nothing until released — the slow SFTP destination. */
function blockedSink(): Writable & { release: () => void; written: () => number } {
  let pending: (() => void) | null = null;
  let written = 0;
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _enc, cb) {
      written += chunk.byteLength;
      pending = () => cb();
    },
  }) as Writable & { release: () => void; written: () => number };
  sink.release = () => {
    const run = pending;
    pending = null;
    run?.();
  };
  sink.written = () => written;
  return sink;
}

const tick = () => new Promise((r) => setImmediate(r));

describe("frame parsing", () => {
  it("routes stdout and stderr frames to their own sinks", async () => {
    const src = Readable.from([Buffer.concat([frame(1, "dump"), frame(2, "warn"), frame(1, "-more")])]);
    const out = new PassThrough();
    const err = new PassThrough();
    const outSeen: Buffer[] = [];
    const errSeen: Buffer[] = [];
    out.on("data", (c: Buffer) => outSeen.push(c));
    err.on("data", (c: Buffer) => errSeen.push(c));

    demuxDockerStream(src, out, err);
    await new Promise((r) => src.on("end", r));
    await tick();

    expect(Buffer.concat(outSeen).toString()).toBe("dump-more");
    expect(Buffer.concat(errSeen).toString()).toBe("warn");
  });

  it("reassembles a frame split across chunks, header included", async () => {
    // The split lands INSIDE the 8-byte header, the case a per-chunk parser gets
    // wrong and the one a real socket produces constantly on a big dump.
    const whole = frame(1, "abcdefghij");
    const src = Readable.from([whole.subarray(0, 3), whole.subarray(3, 11), whole.subarray(11)]);
    const out = new PassThrough();
    const seen: Buffer[] = [];
    out.on("data", (c: Buffer) => seen.push(c));

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable);
    await new Promise((r) => src.on("end", r));
    await tick();

    expect(Buffer.concat(seen).toString()).toBe("abcdefghij");
  });

  it("drops stdin echo frames rather than mixing them into the artifact", async () => {
    const src = Readable.from([Buffer.concat([frame(1, "real"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 4]), Buffer.from("echo")])]);
    const out = new PassThrough();
    const seen: Buffer[] = [];
    out.on("data", (c: Buffer) => seen.push(c));

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable);
    await new Promise((r) => src.on("end", r));
    await tick();

    expect(Buffer.concat(seen).toString()).toBe("real");
  });
});

describe("backpressure — the #633 fix", () => {
  it("stops pulling from the source while the destination is blocked", async () => {
    // Ten frames, a sink that accepts one write at a time. An unbounded demuxer
    // drains the source to completion regardless of the sink; this must not.
    const chunks = Array.from({ length: 10 }, (_, i) => frame(1, `chunk-${i}`));
    const src = scriptedSource(chunks);
    const sink = blockedSink();

    demuxDockerStream(src, sink, new PassThrough().resume() as unknown as Writable);
    for (let i = 0; i < 20; i++) await tick();

    // The two halves of the claim: we stopped reading, and we stopped early.
    expect(src.isPaused()).toBe(true);
    expect(src.delivered()).toBeLessThan(chunks.length);

    // Releasing the sink resumes the source — pressure is relieved, not fatal.
    const before = src.delivered();
    for (let i = 0; i < 60; i++) {
      sink.release();
      await tick();
    }
    expect(src.delivered()).toBeGreaterThan(before);
  });

  it("registers one drain listener per blocked sink, not one per chunk", async () => {
    // The unbalanced-counter bug: N listeners for one drain would resume the source
    // while the sink is still full, silently restoring the unbounded behaviour.
    //
    // All 50 frames arrive in ONE chunk, and that is what gives this teeth. The
    // demuxer's inner loop drains a whole chunk before it can pause anything, so a
    // blocked sink is written to 50 times in a row — the exact shape that accumulates
    // a listener per write. Spread across 50 chunks the source would pause after the
    // first, only one or two writes would ever happen, and the assertion would hold
    // just as well against the buggy version.
    const src = scriptedSource([Buffer.concat(Array.from({ length: 50 }, (_, i) => frame(1, `c${i}`)))]);
    const sink = blockedSink();

    demuxDockerStream(src, sink, new PassThrough().resume() as unknown as Writable);
    for (let i = 0; i < 30; i++) await tick();

    expect(sink.listenerCount("drain")).toBe(1);
  });
});

describe("desync is fatal, not silent", () => {
  it("fails on an impossible stream type instead of routing it to stderr", async () => {
    const src = Readable.from([Buffer.concat([frame(1, "good"), Buffer.from([9, 0, 0, 0, 0, 0, 0, 1, 0x41])])]);
    const out = new PassThrough();
    out.resume();
    out.on("error", () => {}); // a consumer must handle its source's errors
    const reported: Error[] = [];

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable, (e) =>
      reported.push(e),
    );
    await tick();
    await tick();

    expect(reported[0]?.message).toMatch(/desynchronized/);
  });

  it("refuses a frame length past the sanity ceiling rather than waiting forever", async () => {
    const bogus = Buffer.alloc(8);
    bogus[0] = 1;
    bogus.writeUInt32BE(0xffffffff, 4);
    const src = Readable.from([bogus]);
    const out = new PassThrough();
    out.resume();
    out.on("error", () => {});
    const reported: Error[] = [];

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable, (e) =>
      reported.push(e),
    );
    await tick();
    await tick();

    expect(reported[0]?.message).toMatch(/sanity ceiling/);
  });

  it("reports a source error rather than letting it read as a clean end", async () => {
    const src = new Readable({ read() {} });
    const out = new PassThrough();
    out.resume();
    out.on("error", () => {});
    const reported: Error[] = [];

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable, (e) =>
      reported.push(e),
    );
    src.destroy(new Error("socket hung up mid-dump"));
    await tick();

    expect(reported[0]?.message).toMatch(/socket hung up/);
  });

  it("treats an end mid-frame as truncation, not a clean finish", () => {
    // The daemon only writes whole frames, so a partial one at EOF means the stream
    // was cut. It has to be an error: we hash and record whatever arrived, so a
    // short artifact would pass its own integrity check at restore time and read as
    // a smaller database.
    const whole = frame(1, "0123456789");
    const src = Readable.from([whole.subarray(0, 12)]); // header + 4 of 10 bytes
    const out = new PassThrough();
    out.resume();
    out.on("error", () => {});
    const reported: Error[] = [];

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable, (e) =>
      reported.push(e),
    );

    return new Promise<void>((resolve) =>
      src.on("end", () => {
        setImmediate(() => {
          expect(reported[0]?.message).toMatch(/ended mid-frame/);
          resolve();
        });
      }),
    );
  });

  it("does not cry truncation on a stream that ended cleanly", () => {
    const src = Readable.from([frame(1, "done")]);
    const out = new PassThrough();
    out.resume();
    const reported: Error[] = [];

    demuxDockerStream(src, out, new PassThrough().resume() as unknown as Writable, (e) =>
      reported.push(e),
    );

    return new Promise<void>((resolve) =>
      src.on("end", () => {
        setImmediate(() => {
          expect(reported).toEqual([]);
          resolve();
        });
      }),
    );
  });
});
